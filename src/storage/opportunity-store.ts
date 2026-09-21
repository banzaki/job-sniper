import { constants, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { DatabaseSync, type SQLOutputValue, type StatementSync } from 'node:sqlite';
import type { FilterResult } from '../domain/filter-result.js';
import {
  opportunityId,
  UNKNOWN_ACCESS,
  type Opportunity,
  type OpportunityAccess,
  type OpportunityKey,
} from '../domain/opportunity.js';
import { ANALYSIS_SCHEMA, AnalysisStore } from './analysis-store.js';
import { runInTransaction } from './db-util.js';
import { DeliveryStore } from './delivery-store.js';
import { QueueStore } from './queue-store.js';
import { QuotaStore } from './quota-store.js';
import { SCHEMA_V3 } from './schema-v3.js';

/**
 * 1: opportunities. 2: adds analyses and proposal_drafts. 3: adds the discovery queue, multi-part deliveries,
 * quota accounting and run locks. Upgrades only add tables: existing rows are never touched.
 */
const SCHEMA_VERSION = 3;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS opportunities (
  id                          TEXT PRIMARY KEY,
  source_id                   TEXT NOT NULL,
  external_id                 TEXT NOT NULL,
  title                       TEXT NOT NULL,
  url                         TEXT NOT NULL,
  status                      TEXT NOT NULL,
  payload_json                TEXT NOT NULL,
  first_seen_at               TEXT NOT NULL,
  last_seen_at                TEXT NOT NULL,
  filter_decision             TEXT NOT NULL CHECK (filter_decision IN ('shortlist', 'review', 'skip')),
  filter_reasons_json         TEXT NOT NULL,
  filter_keywords_json        TEXT NOT NULL,
  filter_evaluated_at         TEXT NOT NULL,
  filter_rule_version         TEXT NOT NULL,
  notified_at                 TEXT,
  UNIQUE (source_id, external_id)
);
`;

/** The stored data could not be read back (corrupted or unexpected content). */
export class StoreDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoreDataError';
  }
}

export interface StoredOpportunity {
  opportunity: Opportunity;
  filter: FilterResult;
  firstSeenAt: string;
  lastSeenAt: string;
  notifiedAt: string | null;
}

/** Generic SQLite persistence for normalized opportunities. Knows nothing about any platform. */
export class OpportunityStore {
  private readonly db: DatabaseSync;
  private readonly hasStatement: StatementSync;
  private readonly touchStatement: StatementSync;
  private readonly insertStatement: StatementSync;
  private readonly getStatement: StatementSync;
  private readonly countStatement: StatementSync;
  private readonly updateFilterStatement: StatementSync;
  private readonly markNotifiedStatement: StatementSync;
  /** AI analyses and proposal drafts, on the same connection. */
  readonly analyses: AnalysisStore;
  /** Discovered summaries waiting for their detail. */
  readonly queue: QueueStore;
  /** Multi-part message deliveries and their confirmations. */
  readonly deliveries: DeliveryStore;
  /** Request accounting, cooldowns and locks for the AI provider. */
  readonly quota: QuotaStore;

  /** Opens (creating the folder and file when missing) the database at `path`. */
  constructor(path: string) {
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.db = new DatabaseSync(path);
    try {
      this.migrate(path);
      this.analyses = new AnalysisStore(this.db);
      this.queue = new QueueStore(this.db);
      this.deliveries = new DeliveryStore(this.db);
      this.quota = new QuotaStore(this.db);
      this.hasStatement = this.db.prepare(
        'SELECT 1 AS present FROM opportunities WHERE source_id = ? AND external_id = ?',
      );
      this.touchStatement = this.db.prepare(
        'UPDATE opportunities SET last_seen_at = ? WHERE source_id = ? AND external_id = ?',
      );
      this.insertStatement = this.db.prepare(`
        INSERT INTO opportunities (
          id, source_id, external_id, title, url, status, payload_json,
          first_seen_at, last_seen_at,
          filter_decision, filter_reasons_json, filter_keywords_json,
          filter_evaluated_at, filter_rule_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      this.getStatement = this.db.prepare(
        'SELECT * FROM opportunities WHERE source_id = ? AND external_id = ?',
      );
      this.countStatement = this.db.prepare('SELECT COUNT(*) AS total FROM opportunities');
      this.updateFilterStatement = this.db.prepare(`
        UPDATE opportunities SET
          filter_decision = ?, filter_reasons_json = ?, filter_keywords_json = ?,
          filter_evaluated_at = ?, filter_rule_version = ?
        WHERE source_id = ? AND external_id = ?`);
      this.markNotifiedStatement = this.db.prepare(
        'UPDATE opportunities SET notified_at = ? WHERE source_id = ? AND external_id = ? AND notified_at IS NULL',
      );
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  has(key: OpportunityKey): boolean {
    return this.hasStatement.get(key.sourceId, key.externalId) !== undefined;
  }

  /** Records that known opportunities were seen again. Does not change anything else. */
  touchSeen(keys: readonly OpportunityKey[], seenAt: string): void {
    this.transaction(() => {
      for (const key of keys) {
        this.touchStatement.run(seenAt, key.sourceId, key.externalId);
      }
    });
  }

  /** Inserts a new opportunity. Throws if it already exists (unique source_id + external_id). */
  insert(opportunity: Opportunity, filter: FilterResult, seenAt: string): void {
    this.insertStatement.run(
      opportunityId(opportunity),
      opportunity.sourceId,
      opportunity.externalId,
      opportunity.title,
      opportunity.url,
      opportunity.status,
      JSON.stringify(opportunity),
      seenAt,
      seenAt,
      filter.decision,
      JSON.stringify(filter.reasons),
      JSON.stringify(filter.matchedKeywords),
      filter.evaluatedAt,
      filter.ruleVersion,
    );
  }

  /** Runs `work` in one transaction (all-or-nothing). Not re-entrant. */
  batch<T>(work: () => T): T {
    return runInTransaction(this.db, work);
  }

  /**
   * Stores an opportunity whose detail was just obtained AND marks its queue item done, in one transaction:
   * a detail counts as obtained only after the opportunity is persisted. Also fine when no queue item exists.
   */
  persistDetail(opportunity: Opportunity, filter: FilterResult, seenAt: string): void {
    this.transaction(() => {
      this.insert(opportunity, filter, seenAt);
      this.queue.markDone(opportunity, seenAt);
    });
  }

  get(key: OpportunityKey): StoredOpportunity | null {
    const row = this.getStatement.get(key.sourceId, key.externalId);
    if (!row) return null;

    const id = opportunityId(key);
    const opportunity = parseObject<Opportunity>(column(row, 'payload_json', id), 'payload_json', id);
    // Rows stored before access rules existed have no "access": their restriction is simply unknown.
    if (!opportunity.access) opportunity.access = { ...UNKNOWN_ACCESS };
    return {
      opportunity,
      filter: {
        decision: column(row, 'filter_decision', id) as FilterResult['decision'],
        reasons: parseObject<string[]>(column(row, 'filter_reasons_json', id), 'filter_reasons_json', id),
        matchedKeywords: parseObject<string[]>(
          column(row, 'filter_keywords_json', id),
          'filter_keywords_json',
          id,
        ),
        evaluatedAt: column(row, 'filter_evaluated_at', id),
        ruleVersion: column(row, 'filter_rule_version', id),
      },
      firstSeenAt: column(row, 'first_seen_at', id),
      lastSeenAt: column(row, 'last_seen_at', id),
      notifiedAt: nullableColumn(row, 'notified_at', id),
    };
  }

  /** Every stored key, oldest first. Callers read each row with get() so one bad row is isolated. */
  listKeys(): OpportunityKey[] {
    return this.readKeys('SELECT source_id, external_id FROM opportunities ORDER BY first_seen_at, id');
  }

  /** Keys whose filter result was produced by a different rule version. */
  listKeysNotEvaluatedWith(ruleVersion: string): OpportunityKey[] {
    return this.readKeys(
      'SELECT source_id, external_id FROM opportunities WHERE filter_rule_version <> ? ORDER BY first_seen_at, id',
      ruleVersion,
    );
  }

  /**
   * Keys with one of the given decisions that were never notified, oldest first. With `analysisVersion`,
   * opportunities the AI judged a clear skip for that version are left out (not worth a message).
   */
  listPendingNotification(
    decisions: readonly FilterResult['decision'][],
    analysisVersion?: string,
  ): OpportunityKey[] {
    if (decisions.length === 0) return [];
    // Only "?" placeholders are generated; the decision values are bound as parameters.
    const placeholders = decisions.map(() => '?').join(', ');
    const notSkippedByAi = analysisVersion
      ? `AND NOT EXISTS (
           SELECT 1 FROM analyses a
           WHERE a.source_id = o.source_id AND a.external_id = o.external_id
             AND a.analysis_version = ? AND a.status = 'success' AND a.recommendation = 'skip')`
      : '';
    return this.readKeys(
      `SELECT o.source_id, o.external_id FROM opportunities o
       WHERE o.notified_at IS NULL AND o.filter_decision IN (${placeholders})
       ${notSkippedByAi}
       ORDER BY o.first_seen_at, o.id`,
      ...decisions,
      ...(analysisVersion ? [analysisVersion] : []),
    );
  }

  /**
   * Replaces the filter result of stored opportunities. Touches nothing else:
   * first_seen_at, last_seen_at and notified_at stay as they are.
   */
  updateFilters(updates: readonly { key: OpportunityKey; filter: FilterResult }[]): void {
    this.transaction(() => {
      for (const { key, filter } of updates) {
        this.updateFilterStatement.run(
          filter.decision,
          JSON.stringify(filter.reasons),
          JSON.stringify(filter.matchedKeywords),
          filter.evaluatedAt,
          filter.ruleVersion,
          key.sourceId,
          key.externalId,
        );
      }
    });
  }

  /**
   * Replaces only the access information of a stored opportunity (and records when it was checked).
   * Nothing else changes: not the filter result, first_seen_at or notified_at.
   */
  updateAccess(key: OpportunityKey, access: OpportunityAccess, checkedAt: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE opportunities
         SET payload_json = json_set(payload_json, '$.access', json(?), '$.sourceMetadata.accessCheckedAt', ?)
         WHERE source_id = ? AND external_id = ?`,
      )
      .run(JSON.stringify(access), checkedAt, key.sourceId, key.externalId);
    return Number(result.changes) === 1;
  }

  /** Marks an opportunity as notified. Returns false when it was missing or already notified. */
  markNotified(key: OpportunityKey, notifiedAt: string): boolean {
    const result = this.markNotifiedStatement.run(notifiedAt, key.sourceId, key.externalId);
    return Number(result.changes) === 1;
  }

  count(): number {
    const row = this.countStatement.get();
    const total = row?.total;
    if (typeof total !== 'number') {
      throw new StoreDataError('Could not count stored opportunities.');
    }
    return total;
  }

  private readKeys(sql: string, ...params: string[]): OpportunityKey[] {
    return this.db.prepare(sql).all(...params).map((row) => ({
      sourceId: column(row, 'source_id', '(list)'),
      externalId: column(row, 'external_id', '(list)'),
    }));
  }

  /**
   * Brings the database to SCHEMA_VERSION. Every statement is CREATE ... IF NOT EXISTS, so it is safe to
   * repeat and it never modifies existing rows. An existing older file is copied once before its upgrade
   * (next to it, as "<name>.pre-v<target>.<ext>", which the .gitignore rules for database files cover).
   */
  private migrate(path: string): void {
    const row = this.db.prepare('PRAGMA user_version').get();
    const version = typeof row?.user_version === 'number' ? row.user_version : 0;
    if (version > SCHEMA_VERSION) {
      throw new StoreDataError(
        `Database schema version ${version} is newer than this program supports (${SCHEMA_VERSION}).`,
      );
    }
    if (version >= 1 && version < SCHEMA_VERSION && path !== ':memory:') {
      const extension = extname(path);
      const backup = join(dirname(path), `${basename(path, extension)}.pre-v${SCHEMA_VERSION}${extension}`);
      if (!existsSync(backup)) copyFileSync(path, backup, constants.COPYFILE_EXCL);
    }
    this.transaction(() => {
      this.db.exec(SCHEMA);
      this.db.exec(ANALYSIS_SCHEMA);
      this.db.exec(SCHEMA_V3);
    });
    if (version < SCHEMA_VERSION) {
      this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    }
  }

  private transaction(work: () => void): void {
    this.db.exec('BEGIN');
    try {
      work();
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}

function column(row: Record<string, SQLOutputValue>, name: string, id: string): string {
  const value = row[name];
  if (typeof value !== 'string') {
    throw new StoreDataError(`Stored opportunity ${id} has an unexpected value in column "${name}".`);
  }
  return value;
}

function nullableColumn(row: Record<string, SQLOutputValue>, name: string, id: string): string | null {
  return row[name] === null ? null : column(row, name, id);
}

function parseObject<T>(json: string, name: string, id: string): T {
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error('not an object or array');
    }
    return parsed as T;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new StoreDataError(`Stored opportunity ${id} has invalid JSON in "${name}": ${reason}`);
  }
}
