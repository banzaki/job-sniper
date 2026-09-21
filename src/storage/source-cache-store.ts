import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';

/** What a source remembers between runs: its last good response and when it may ask again. */
export interface SourceCacheEntry {
  sourceId: string;
  /** The last successful response body, exactly as received; null until one succeeded. */
  payloadJson: string | null;
  fetchedAt: string | null;
  lastAttemptAt: string | null;
  /** No new request before this time (ISO); null when the source was never queried. */
  nextAttemptAt: string | null;
  attempts: number;
  consecutiveFailures: number;
  lastError: string | null;
}

/** The storage a feed-style source needs; implemented by SourceCacheStore and, in tests, by a plain object. */
export interface SourceCache {
  get(sourceId: string): SourceCacheEntry | null;
  /** Called BEFORE the request, so an attempt that crashes half way still counts against the interval. */
  beginAttempt(sourceId: string, at: string, nextAttemptAt: string): void;
  recordSuccess(sourceId: string, payloadJson: string, at: string, nextAttemptAt: string): void;
  recordFailure(sourceId: string, at: string, message: string, nextAttemptAt: string): void;
}

const MAX_ERROR_LENGTH = 500;

export class SourceCacheDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourceCacheDataError';
  }
}

/** SQLite-backed SourceCache. The response and the attempt clock survive restarts. */
export class SourceCacheStore implements SourceCache {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  get(sourceId: string): SourceCacheEntry | null {
    const row = this.db.prepare('SELECT * FROM source_cache WHERE source_id = ?').get(sourceId);
    return row ? toEntry(row) : null;
  }

  beginAttempt(sourceId: string, at: string, nextAttemptAt: string): void {
    this.db
      .prepare(
        `INSERT INTO source_cache (source_id, last_attempt_at, next_attempt_at, attempts)
         VALUES (?, ?, ?, 1)
         ON CONFLICT (source_id) DO UPDATE SET
           last_attempt_at = excluded.last_attempt_at,
           next_attempt_at = excluded.next_attempt_at,
           attempts = attempts + 1`,
      )
      .run(sourceId, at, nextAttemptAt);
  }

  recordSuccess(sourceId: string, payloadJson: string, at: string, nextAttemptAt: string): void {
    this.db
      .prepare(
        `INSERT INTO source_cache (source_id, payload_json, fetched_at, last_attempt_at, next_attempt_at, attempts)
         VALUES (?, ?, ?, ?, ?, 1)
         ON CONFLICT (source_id) DO UPDATE SET
           payload_json = excluded.payload_json,
           fetched_at = excluded.fetched_at,
           next_attempt_at = excluded.next_attempt_at,
           consecutive_failures = 0,
           last_error = NULL`,
      )
      .run(sourceId, payloadJson, at, at, nextAttemptAt);
  }

  recordFailure(sourceId: string, at: string, message: string, nextAttemptAt: string): void {
    this.db
      .prepare(
        `INSERT INTO source_cache (source_id, last_attempt_at, next_attempt_at, attempts, consecutive_failures, last_error)
         VALUES (?, ?, ?, 1, 1, ?)
         ON CONFLICT (source_id) DO UPDATE SET
           next_attempt_at = excluded.next_attempt_at,
           consecutive_failures = consecutive_failures + 1,
           last_error = excluded.last_error`,
      )
      .run(sourceId, at, nextAttemptAt, message.slice(0, MAX_ERROR_LENGTH));
  }
}

function text(row: Record<string, SQLOutputValue>, column: string): string | null {
  const value = row[column];
  if (value === null) return null;
  if (typeof value !== 'string') throw new SourceCacheDataError(`Unexpected value in source_cache column "${column}".`);
  return value;
}

function toEntry(row: Record<string, SQLOutputValue>): SourceCacheEntry {
  const sourceId = text(row, 'source_id');
  if (sourceId === null) throw new SourceCacheDataError('source_cache row without source_id.');
  return {
    sourceId,
    payloadJson: text(row, 'payload_json'),
    fetchedAt: text(row, 'fetched_at'),
    lastAttemptAt: text(row, 'last_attempt_at'),
    nextAttemptAt: text(row, 'next_attempt_at'),
    attempts: Number(row.attempts),
    consecutiveFailures: Number(row.consecutive_failures),
    lastError: text(row, 'last_error'),
  };
}
