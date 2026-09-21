import type { DatabaseSync, SQLOutputValue, StatementSync } from 'node:sqlite';
import type { MatchAnalysis } from '../domain/match-analysis.js';
import { opportunityId, type OpportunityKey } from '../domain/opportunity.js';

/** Added in schema version 2. Every statement is idempotent so the migration can run any number of times. */
export const ANALYSIS_SCHEMA = `
CREATE TABLE IF NOT EXISTS analyses (
  source_id            TEXT NOT NULL,
  external_id          TEXT NOT NULL,
  analysis_version     TEXT NOT NULL,
  status               TEXT NOT NULL CHECK (status IN ('success', 'failed')),
  provider             TEXT NOT NULL,
  model                TEXT NOT NULL,
  attempted_at         TEXT NOT NULL,
  attempts             INTEGER NOT NULL DEFAULT 1,
  score                INTEGER,
  confidence           TEXT,
  recommendation       TEXT,
  model_recommendation TEXT,
  result_json          TEXT,
  error_message        TEXT,
  notified_at          TEXT,
  PRIMARY KEY (source_id, external_id, analysis_version)
);
CREATE TABLE IF NOT EXISTS proposal_drafts (
  source_id        TEXT NOT NULL,
  external_id      TEXT NOT NULL,
  analysis_version TEXT NOT NULL,
  language         TEXT NOT NULL,
  body             TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'submitted', 'discarded')),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  PRIMARY KEY (source_id, external_id, analysis_version)
);
CREATE INDEX IF NOT EXISTS idx_analyses_version_status ON analyses (analysis_version, status);
`;

const MAX_ERROR_LENGTH = 500;

export interface StoredAnalysis {
  analysis: MatchAnalysis;
  notifiedAt: string | null;
}

export interface AnalysisRow {
  key: OpportunityKey;
  analysisVersion: string;
  status: 'success' | 'failed';
  provider: string;
  model: string;
  attemptedAt: string;
  attempts: number;
  score: number | null;
  recommendation: string | null;
  errorMessage: string | null;
  notifiedAt: string | null;
}

export interface AnalysisSelection {
  /** Newest first, at most `limit`. */
  keys: OpportunityKey[];
  /** Everything eligible, before the limit. */
  totalEligible: number;
}

export interface AnalysisCounts {
  /** Open opportunities without a successful analysis for the version (failed attempts included). */
  pending: number;
  success: number;
  /** Opportunities whose attempts all failed so far. */
  failed: number;
}

export class AnalysisDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnalysisDataError';
  }
}

/** Persistence of AI analyses and their proposal drafts. Shares the opportunity database connection. */
export class AnalysisStore {
  private readonly db: DatabaseSync;
  private readonly existingStatement: StatementSync;
  private readonly upsertStatement: StatementSync;
  private readonly upsertDraftStatement: StatementSync;
  private readonly failureStatement: StatementSync;
  private readonly getStatement: StatementSync;
  private readonly draftStatement: StatementSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    this.existingStatement = db.prepare(
      'SELECT status FROM analyses WHERE source_id = ? AND external_id = ? AND analysis_version = ?',
    );
    this.upsertStatement = db.prepare(`
      INSERT INTO analyses (
        source_id, external_id, analysis_version, status, provider, model, attempted_at, attempts,
        score, confidence, recommendation, model_recommendation, result_json, error_message
      ) VALUES (?, ?, ?, 'success', ?, ?, ?, 1, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT (source_id, external_id, analysis_version) DO UPDATE SET
        status = 'success', provider = excluded.provider, model = excluded.model,
        attempted_at = excluded.attempted_at, attempts = analyses.attempts + 1,
        score = excluded.score, confidence = excluded.confidence,
        recommendation = excluded.recommendation, model_recommendation = excluded.model_recommendation,
        result_json = excluded.result_json, error_message = NULL`);
    this.upsertDraftStatement = db.prepare(`
      INSERT INTO proposal_drafts (
        source_id, external_id, analysis_version, language, body, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'draft', ?, ?)
      ON CONFLICT (source_id, external_id, analysis_version) DO UPDATE SET
        language = excluded.language, body = excluded.body, status = 'draft', updated_at = excluded.updated_at`);
    this.failureStatement = db.prepare(`
      INSERT INTO analyses (
        source_id, external_id, analysis_version, status, provider, model, attempted_at, attempts, error_message
      ) VALUES (?, ?, ?, 'failed', ?, ?, ?, 1, ?)
      ON CONFLICT (source_id, external_id, analysis_version) DO UPDATE SET
        provider = excluded.provider, model = excluded.model, attempted_at = excluded.attempted_at,
        attempts = analyses.attempts + 1, error_message = excluded.error_message
      WHERE analyses.status = 'failed'`);
    this.getStatement = db.prepare(
      `SELECT * FROM analyses WHERE source_id = ? AND external_id = ? AND analysis_version = ? AND status = 'success'`,
    );
    this.draftStatement = db.prepare(
      'SELECT language, body, status FROM proposal_drafts WHERE source_id = ? AND external_id = ? AND analysis_version = ?',
    );
  }

  /**
   * Open opportunities that still need an analysis for `version`, newest first (by publication time,
   * falling back to when they were first seen). Cancelled, closed and unknown-status ones are never
   * selected, even when forced. `force` includes ones already analyzed.
   */
  select(version: string, options: { limit: number; force?: boolean; only?: OpportunityKey }): AnalysisSelection {
    const force = options.force ? 1 : 0;
    const onlyClause = options.only ? 'AND o.source_id = ? AND o.external_id = ?' : '';
    const where = `
      FROM opportunities o
      WHERE o.status = 'open'
        AND (? = 1 OR NOT EXISTS (
          SELECT 1 FROM analyses a
          WHERE a.source_id = o.source_id AND a.external_id = o.external_id
            AND a.analysis_version = ? AND a.status = 'success'))
        ${onlyClause}`;
    const params: (string | number)[] = [force, version];
    if (options.only) params.push(options.only.sourceId, options.only.externalId);

    const total = this.db.prepare(`SELECT COUNT(*) AS total ${where}`).get(...params)?.total;
    const rows = this.db
      .prepare(
        `SELECT o.source_id, o.external_id ${where}
         ORDER BY COALESCE(json_extract(o.payload_json, '$.publishedAt'), o.first_seen_at) DESC, o.id DESC
         LIMIT ?`,
      )
      .all(...params, options.limit);

    return {
      keys: rows.map((row) => ({ sourceId: text(row, 'source_id'), externalId: text(row, 'external_id') })),
      totalEligible: typeof total === 'number' ? total : 0,
    };
  }

  /**
   * Stores a successful analysis and its proposal draft together. A successful analysis for the same
   * opportunity and version is never overwritten unless `replace` is set; a replacement keeps the
   * notification state so an update is never sent twice.
   */
  save(analysis: MatchAnalysis, options: { replace?: boolean } = {}): void {
    const { proposal, ...stored } = analysis;
    this.transaction(() => {
      const existing = this.existingStatement.get(analysis.sourceId, analysis.externalId, analysis.analysisVersion);
      if (existing?.status === 'success' && !options.replace) {
        throw new AnalysisDataError(
          `Analysis ${opportunityId(analysis)} (${analysis.analysisVersion}) already exists and was not replaced.`,
        );
      }
      this.upsertStatement.run(
        analysis.sourceId, analysis.externalId, analysis.analysisVersion,
        analysis.provider, analysis.model, analysis.analyzedAt,
        analysis.score, analysis.confidence, analysis.recommendation, analysis.modelRecommendation,
        JSON.stringify(stored),
      );
      this.upsertDraftStatement.run(
        analysis.sourceId, analysis.externalId, analysis.analysisVersion,
        proposal.language, proposal.text, analysis.analyzedAt, analysis.analyzedAt,
      );
    });
  }

  /** Records a failed attempt (message trimmed; never a secret). A success is never downgraded. */
  recordFailure(failure: {
    key: OpportunityKey;
    analysisVersion: string;
    provider: string;
    model: string;
    message: string;
    at: string;
  }): void {
    this.failureStatement.run(
      failure.key.sourceId, failure.key.externalId, failure.analysisVersion,
      failure.provider, failure.model, failure.at, failure.message.slice(0, MAX_ERROR_LENGTH),
    );
  }

  /** The successful analysis (with its proposal draft) for an opportunity and version, or null. */
  get(key: OpportunityKey, version: string): StoredAnalysis | null {
    const row = this.getStatement.get(key.sourceId, key.externalId, version);
    if (!row) return null;
    const id = `${opportunityId(key)} (${version})`;

    let stored: Omit<MatchAnalysis, 'proposal'>;
    try {
      const parsed: unknown = JSON.parse(text(row, 'result_json'));
      if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object');
      stored = parsed as Omit<MatchAnalysis, 'proposal'>;
    } catch (error) {
      throw new AnalysisDataError(
        `Stored analysis ${id} has invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    // Results stored before skill verification existed carry no "verification": read them as unverified.
    // Older results may also predate the "essential"/"notCovered" fields.
    if (stored.verification) {
      stored.verification.essential ??= [];
      stored.verification.notCovered ??= [];
    }
    if (!stored.verification) {
      stored.verification = {
        status: 'unverified',
        essential: [],
        confirmed: [],
        unverified: [],
        learning: [],
        notCovered: [],
        note: 'Stored before skill verification existed.',
      };
    }
    const draft = this.draftStatement.get(key.sourceId, key.externalId, version);
    if (!draft) throw new AnalysisDataError(`Stored analysis ${id} has no proposal draft.`);

    return {
      analysis: {
        ...stored,
        proposal: {
          language: text(draft, 'language'),
          text: text(draft, 'body'),
          status: text(draft, 'status') as MatchAnalysis['proposal']['status'],
        },
      },
      notifiedAt: row.notified_at === null ? null : text(row, 'notified_at'),
    };
  }

  /** Analysis attempts for a version, newest attempt first, optionally only successes or only failures. */
  list(version: string, status?: 'success' | 'failed'): AnalysisRow[] {
    const rows = status
      ? this.db.prepare('SELECT * FROM analyses WHERE analysis_version = ? AND status = ? ORDER BY attempted_at DESC').all(version, status)
      : this.db.prepare('SELECT * FROM analyses WHERE analysis_version = ? ORDER BY attempted_at DESC').all(version);
    return rows.map((row) => ({
      key: { sourceId: text(row, 'source_id'), externalId: text(row, 'external_id') },
      analysisVersion: text(row, 'analysis_version'),
      status: text(row, 'status') as AnalysisRow['status'],
      provider: text(row, 'provider'),
      model: text(row, 'model'),
      attemptedAt: text(row, 'attempted_at'),
      attempts: Number(row.attempts),
      score: typeof row.score === 'number' ? row.score : null,
      recommendation: typeof row.recommendation === 'string' ? row.recommendation : null,
      errorMessage: typeof row.error_message === 'string' ? row.error_message : null,
      notifiedAt: typeof row.notified_at === 'string' ? row.notified_at : null,
    }));
  }

  counts(version: string): AnalysisCounts {
    const pending = this.select(version, { limit: 1 }).totalEligible;
    const one = (sql: string): number => {
      const total = this.db.prepare(sql).get(version)?.total;
      return typeof total === 'number' ? total : 0;
    };
    return {
      pending,
      success: one(`SELECT COUNT(*) AS total FROM analyses WHERE analysis_version = ? AND status = 'success'`),
      failed: one(`SELECT COUNT(*) AS total FROM analyses WHERE analysis_version = ? AND status = 'failed'`),
    };
  }

  /**
   * Invalidates for use every still-"draft" proposal produced under a version other than the current one
   * (an older prompt or an older candidate profile). Only the draft status changes, to "discarded": the
   * analyses and the proposal text stay as history, and approved or submitted drafts are never touched.
   * Idempotent. Returns how many drafts were discarded.
   */
  discardSuperseded(currentVersion: string, at: string): number {
    const result = this.db
      .prepare(`UPDATE proposal_drafts SET status = 'discarded', updated_at = ? WHERE analysis_version <> ? AND status = 'draft'`)
      .run(at, currentVersion);
    return Number(result.changes);
  }

  /** Successful analyses kept as history under versions other than the current one. */
  countSuperseded(currentVersion: string): number {
    const total = this.db
      .prepare(`SELECT COUNT(*) AS total FROM analyses WHERE analysis_version <> ? AND status = 'success'`)
      .get(currentVersion)?.total;
    return typeof total === 'number' ? total : 0;
  }

  /** Successful analyses never announced on their own, excluding clear skips (not worth a message). Oldest first. */
  listPendingNotification(version: string): OpportunityKey[] {
    return this.db
      .prepare(
        `SELECT source_id, external_id FROM analyses
         WHERE analysis_version = ? AND status = 'success' AND notified_at IS NULL AND recommendation <> 'skip'
         ORDER BY attempted_at, source_id, external_id`,
      )
      .all(version)
      .map((row) => ({ sourceId: text(row, 'source_id'), externalId: text(row, 'external_id') }));
  }

  /** Marks an analysis as announced. Returns false when it was missing or already announced. */
  markNotified(key: OpportunityKey, version: string, at: string): boolean {
    const result = this.db
      .prepare(
        'UPDATE analyses SET notified_at = ? WHERE source_id = ? AND external_id = ? AND analysis_version = ? AND notified_at IS NULL',
      )
      .run(at, key.sourceId, key.externalId, version);
    return Number(result.changes) === 1;
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

function text(row: Record<string, SQLOutputValue>, column: string): string {
  const value = row[column];
  if (typeof value !== 'string') {
    throw new AnalysisDataError(`Unexpected value in analyses column "${column}".`);
  }
  return value;
}
