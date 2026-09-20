import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type SQLOutputValue, type StatementSync } from 'node:sqlite';
import type { FilterResult } from '../domain/filter-result.js';
import { opportunityId, type Opportunity, type OpportunityKey } from '../domain/opportunity.js';

const SCHEMA_VERSION = 1;

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

  /** Opens (creating the folder and file when missing) the database at `path`. */
  constructor(path: string) {
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.db = new DatabaseSync(path);
    try {
      this.migrate();
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

  get(key: OpportunityKey): StoredOpportunity | null {
    const row = this.getStatement.get(key.sourceId, key.externalId);
    if (!row) return null;

    const id = opportunityId(key);
    return {
      opportunity: parseObject<Opportunity>(column(row, 'payload_json', id), 'payload_json', id),
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

  count(): number {
    const row = this.countStatement.get();
    const total = row?.total;
    if (typeof total !== 'number') {
      throw new StoreDataError('Could not count stored opportunities.');
    }
    return total;
  }

  private migrate(): void {
    const row = this.db.prepare('PRAGMA user_version').get();
    const version = typeof row?.user_version === 'number' ? row.user_version : 0;
    if (version > SCHEMA_VERSION) {
      throw new StoreDataError(
        `Database schema version ${version} is newer than this program supports (${SCHEMA_VERSION}).`,
      );
    }
    this.db.exec(SCHEMA);
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
