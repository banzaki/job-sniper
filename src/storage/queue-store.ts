import type { DatabaseSync, SQLOutputValue, StatementSync } from 'node:sqlite';
import type { OpportunityKey, OpportunitySummary } from '../domain/opportunity.js';

export type QueueState = 'pending' | 'done' | 'unavailable';

export interface QueueRow {
  key: OpportunityKey;
  url: string;
  title: string;
  summary: OpportunitySummary;
  state: QueueState;
  firstDiscoveredAt: string;
  lastDiscoveredAt: string;
  attempts: number;
  notFoundCount: number;
  lastAttemptAt: string | null;
  nextAttemptAt: string | null;
  lastError: string | null;
  unavailableReason: string | null;
  doneAt: string | null;
}

export interface QueueCounts {
  pending: number;
  done: number;
  unavailable: number;
}

/** Not-found answers needed before an item is declared unavailable ("proven"), not merely failing. */
export const NOT_FOUND_LIMIT = 2;
const BASE_BACKOFF_MS = 15 * 60_000;
const MAX_BACKOFF_MS = 24 * 3_600_000;
const MAX_ERROR_LENGTH = 500;

export class QueueDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QueueDataError';
  }
}

/**
 * Persistent queue of discovered summaries whose detail has not been obtained yet. A summary is saved
 * BEFORE its detail is requested, so work survives restarts and items that scroll out of the listing pages.
 * "known" (a row exists) is different from "detail obtained" (state = done).
 */
export class QueueStore {
  private readonly db: DatabaseSync;
  private readonly getStatement: StatementSync;
  private readonly insertStatement: StatementSync;
  private readonly touchStatement: StatementSync;
  private readonly refreshStatement: StatementSync;
  private readonly doneStatement: StatementSync;
  private readonly failStatement: StatementSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    this.getStatement = db.prepare('SELECT * FROM discovery_queue WHERE source_id = ? AND external_id = ?');
    this.insertStatement = db.prepare(`
      INSERT INTO discovery_queue (source_id, external_id, url, title, summary_json, first_discovered_at, last_discovered_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
    this.touchStatement = db.prepare(
      'UPDATE discovery_queue SET last_discovered_at = ? WHERE source_id = ? AND external_id = ?',
    );
    this.refreshStatement = db.prepare(`
      UPDATE discovery_queue SET url = ?, title = ?, summary_json = ?, last_discovered_at = ?
      WHERE source_id = ? AND external_id = ? AND state = 'pending'`);
    this.doneStatement = db.prepare(`
      UPDATE discovery_queue SET state = 'done', done_at = ?, last_error = NULL, next_attempt_at = NULL
      WHERE source_id = ? AND external_id = ?`);
    this.failStatement = db.prepare(`
      UPDATE discovery_queue SET
        attempts = attempts + 1, last_attempt_at = ?, next_attempt_at = ?, last_error = ?,
        not_found_count = not_found_count + ?, state = ?, unavailable_reason = ?
      WHERE source_id = ? AND external_id = ?`);
  }

  get(key: OpportunityKey): QueueRow | null {
    const row = this.getStatement.get(key.sourceId, key.externalId);
    return row ? toRow(row) : null;
  }

  /**
   * Idempotent: a new summary becomes a pending item; a rediscovered one only updates its last-seen time
   * (and, while still pending, its listing data). Work already done, and failure history, are never reset.
   */
  upsertDiscovered(summary: OpportunitySummary, at: string): { isNew: boolean; state: QueueState } {
    const key = { sourceId: summary.sourceId, externalId: summary.externalId };
    const existing = this.get(key);
    if (!existing) {
      this.insertStatement.run(summary.sourceId, summary.externalId, summary.url, summary.title, JSON.stringify(summary), at, at);
      return { isNew: true, state: 'pending' };
    }
    if (existing.state === 'pending') {
      this.refreshStatement.run(summary.url, summary.title, JSON.stringify(summary), at, summary.sourceId, summary.externalId);
    } else {
      this.touchStatement.run(at, summary.sourceId, summary.externalId);
    }
    return { isNew: false, state: existing.state };
  }

  /** Pending items whose retry time has come, oldest discovery first. */
  listPending(nowIso: string, limit = 1000): QueueRow[] {
    return this.db
      .prepare(
        `SELECT * FROM discovery_queue
         WHERE state = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
         ORDER BY first_discovered_at, external_id LIMIT ?`,
      )
      .all(nowIso, limit)
      .map(toRow);
  }

  /** Marks the detail as obtained. Plain statement: call it inside the transaction that stores the opportunity. */
  markDone(key: OpportunityKey, at: string): void {
    this.doneStatement.run(at, key.sourceId, key.externalId);
  }

  /**
   * Records a failed detail attempt. A temporary error keeps the item pending and backs its retry off
   * (15 min, doubling, at most 24 h). A "not found" answer counts separately; after NOT_FOUND_LIMIT of them
   * the item becomes "unavailable" with its reason, and is not retried again.
   */
  recordFailure(key: OpportunityKey, failure: { at: string; message: string; notFound: boolean }): QueueRow | null {
    const current = this.get(key);
    if (!current) return null;
    const attempts = current.attempts + 1;
    const backoff = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (attempts - 1));
    const notFoundCount = current.notFoundCount + (failure.notFound ? 1 : 0);
    const unavailable = failure.notFound && notFoundCount >= NOT_FOUND_LIMIT;
    const message = failure.message.slice(0, MAX_ERROR_LENGTH);
    this.failStatement.run(
      failure.at,
      unavailable ? null : new Date(Date.parse(failure.at) + backoff).toISOString(),
      message,
      failure.notFound ? 1 : 0,
      unavailable ? 'unavailable' : 'pending',
      unavailable ? message : current.unavailableReason,
      key.sourceId,
      key.externalId,
    );
    return this.get(key);
  }

  counts(): QueueCounts {
    const rows = this.db.prepare('SELECT state, COUNT(*) AS total FROM discovery_queue GROUP BY state').all();
    const counts: QueueCounts = { pending: 0, done: 0, unavailable: 0 };
    for (const row of rows) {
      const state = row.state as QueueState;
      if (state in counts) counts[state] = Number(row.total);
    }
    return counts;
  }
}

function text(row: Record<string, SQLOutputValue>, column: string): string {
  const value = row[column];
  if (typeof value !== 'string') throw new QueueDataError(`Unexpected value in discovery_queue column "${column}".`);
  return value;
}

function nullableText(row: Record<string, SQLOutputValue>, column: string): string | null {
  return row[column] === null ? null : text(row, column);
}

function toRow(row: Record<string, SQLOutputValue>): QueueRow {
  const key = { sourceId: text(row, 'source_id'), externalId: text(row, 'external_id') };
  let summary: OpportunitySummary;
  try {
    summary = JSON.parse(text(row, 'summary_json')) as OpportunitySummary;
  } catch (error) {
    throw new QueueDataError(
      `Queue item ${key.sourceId}:${key.externalId} has invalid summary JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return {
    key,
    url: text(row, 'url'),
    title: text(row, 'title'),
    summary,
    state: text(row, 'state') as QueueState,
    firstDiscoveredAt: text(row, 'first_discovered_at'),
    lastDiscoveredAt: text(row, 'last_discovered_at'),
    attempts: Number(row.attempts),
    notFoundCount: Number(row.not_found_count),
    lastAttemptAt: nullableText(row, 'last_attempt_at'),
    nextAttemptAt: nullableText(row, 'next_attempt_at'),
    lastError: nullableText(row, 'last_error'),
    unavailableReason: nullableText(row, 'unavailable_reason'),
    doneAt: nullableText(row, 'done_at'),
  };
}
