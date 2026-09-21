import type { DatabaseSync } from 'node:sqlite';
import type { FilterDecision } from '../domain/filter-result.js';
import type { OpportunityKey } from '../domain/opportunity.js';
import { runInTransaction } from './db-util.js';

/**
 * Schema version 6 (additive): the alert batch of each collection. Every new opportunity that competed for the alerts of a
 * collection is recorded once, with what happened to it:
 *   selected  one of the best (at most the cap) of its collection: owed to the owner until Telegram confirms it
 *   overflow  new, but outside the cap: stored and consultable, never alerted automatically
 *   expired   selected but its data went stale before it could be delivered: no longer owed
 * opportunities.notified_at stays the only delivery flag; this table never marks anything as delivered.
 */
export const SCHEMA_V6 = `
CREATE TABLE IF NOT EXISTS alert_queue (
  source_id   TEXT NOT NULL,
  external_id TEXT NOT NULL,
  batch_id    TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('selected', 'overflow', 'expired')),
  rank        INTEGER NOT NULL,
  decision    TEXT NOT NULL,
  selected_at TEXT NOT NULL,
  PRIMARY KEY (source_id, external_id)
);
CREATE INDEX IF NOT EXISTS idx_alert_queue_status ON alert_queue (status, batch_id);
`;

export type AlertStatus = 'selected' | 'overflow' | 'expired';

export interface AlertEntry {
  key: OpportunityKey;
  batchId: string;
  status: AlertStatus;
  rank: number;
  decision: string;
  selectedAt: string;
}

export interface AlertRecord {
  key: OpportunityKey;
  status: AlertStatus;
  rank: number;
  decision: FilterDecision;
}

const keyOf = (row: Record<string, unknown>): OpportunityKey => ({ sourceId: String(row.source_id), externalId: String(row.external_id) });

export class AlertQueueStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  get(key: OpportunityKey): AlertEntry | null {
    const row = this.db.prepare('SELECT * FROM alert_queue WHERE source_id = ? AND external_id = ?').get(key.sourceId, key.externalId);
    if (!row) return null;
    return { key: keyOf(row), batchId: String(row.batch_id), status: row.status as AlertStatus, rank: Number(row.rank), decision: String(row.decision), selectedAt: String(row.selected_at) };
  }

  /** Selected earlier, still not delivered and still worth sending (its decision is one of `decisions`), oldest batch first. */
  listSelectedPending(decisions: readonly FilterDecision[]): OpportunityKey[] {
    if (decisions.length === 0) return [];
    return this.db
      .prepare(
        `SELECT q.source_id, q.external_id FROM alert_queue q
         JOIN opportunities o ON o.source_id = q.source_id AND o.external_id = q.external_id
         WHERE q.status = 'selected' AND o.notified_at IS NULL AND o.filter_decision IN (${decisions.map(() => '?').join(', ')})
         ORDER BY q.batch_id, q.rank`,
      )
      .all(...decisions)
      .map(keyOf);
  }

  /** Stored for the first time at or after `since`, undelivered, of a wanted decision, and never considered for an alert before. */
  listNewCandidates(since: string, decisions: readonly FilterDecision[]): OpportunityKey[] {
    if (decisions.length === 0) return [];
    return this.db
      .prepare(
        `SELECT o.source_id, o.external_id FROM opportunities o
         WHERE o.first_seen_at >= ? AND o.notified_at IS NULL AND o.filter_decision IN (${decisions.map(() => '?').join(', ')})
           AND NOT EXISTS (SELECT 1 FROM alert_queue q WHERE q.source_id = o.source_id AND q.external_id = o.external_id)
         ORDER BY o.first_seen_at, o.id`,
      )
      .all(since, ...decisions)
      .map(keyOf);
  }

  /** Owed opportunities that no automatic alert will ever pick: undelivered, of a wanted decision, and not selected. */
  listBacklog(decisions: readonly FilterDecision[]): OpportunityKey[] {
    if (decisions.length === 0) return [];
    return this.db
      .prepare(
        `SELECT o.source_id, o.external_id FROM opportunities o
         WHERE o.notified_at IS NULL AND o.filter_decision IN (${decisions.map(() => '?').join(', ')})
           AND NOT EXISTS (SELECT 1 FROM alert_queue q WHERE q.source_id = o.source_id AND q.external_id = o.external_id AND q.status = 'selected')
         ORDER BY o.first_seen_at, o.id`,
      )
      .all(...decisions)
      .map(keyOf);
  }

  /** Records a whole batch in one transaction, so a crash never leaves it half written. Nothing is overwritten. */
  record(batchId: string, at: string, entries: readonly AlertRecord[]): void {
    if (entries.length === 0) return;
    runInTransaction(this.db, () => {
      const insert = this.db.prepare(
        `INSERT INTO alert_queue (source_id, external_id, batch_id, status, rank, decision, selected_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (source_id, external_id) DO NOTHING`,
      );
      for (const entry of entries) insert.run(entry.key.sourceId, entry.key.externalId, batchId, entry.status, entry.rank, entry.decision, at);
    });
  }

  /** A selected item whose data went stale is no longer owed. The opportunity itself is untouched. */
  expire(keys: readonly OpportunityKey[]): void {
    if (keys.length === 0) return;
    runInTransaction(this.db, () => {
      const update = this.db.prepare("UPDATE alert_queue SET status = 'expired' WHERE source_id = ? AND external_id = ? AND status = 'selected'");
      for (const key of keys) update.run(key.sourceId, key.externalId);
    });
  }

  /**
   * A selected item that the owner then delivered BY HAND (notify:manual) is no longer an automatic alert: its batch id gets the
   * "manual:" prefix, so the automatic count skips it. Nothing else about the entry changes; the delivery flag stays in opportunities.
   */
  markManual(key: OpportunityKey): void {
    this.db
      .prepare("UPDATE alert_queue SET batch_id = 'manual:' || batch_id WHERE source_id = ? AND external_id = ? AND status = 'selected' AND batch_id NOT LIKE 'manual:%'")
      .run(key.sourceId, key.externalId);
  }

  /**
   * What reached the owner in [start, end), in three separate kinds, all derived from the delivery records (so they survive restarts):
   *  - automatic: opportunities that an automatic collection SELECTED (status selected) and Telegram confirmed. Only these use
   *    the personal daily limit;
   *  - manual: opportunities confirmed that no automatic selection chose, or that the owner delivered by hand (a manual delivery,
   *    a backlog send, or an alert sent before the alert queue existed);
   *  - previews: manual previews and demonstrations (deliveries of kind demo), which never mark an opportunity as delivered.
   */
  usageBetween(start: string, end: string): { automatic: number; manual: number; previews: number } {
    const count = (sql: string, ...params: string[]): number => Number(this.db.prepare(sql).get(...params)?.n ?? 0);
    const selected = `EXISTS (SELECT 1 FROM alert_queue q WHERE q.source_id = o.source_id AND q.external_id = o.external_id AND q.status = 'selected' AND q.batch_id NOT LIKE 'manual:%')`;
    return {
      automatic: count(`SELECT COUNT(*) AS n FROM opportunities o WHERE o.notified_at >= ? AND o.notified_at < ? AND ${selected}`, start, end),
      manual: count(`SELECT COUNT(*) AS n FROM opportunities o WHERE o.notified_at >= ? AND o.notified_at < ? AND NOT ${selected}`, start, end),
      previews: count("SELECT COUNT(*) AS n FROM deliveries WHERE kind = 'demo' AND status = 'complete' AND completed_at >= ? AND completed_at < ?", start, end),
    };
  }

  counts(): Record<AlertStatus, number> {
    const result: Record<AlertStatus, number> = { selected: 0, overflow: 0, expired: 0 };
    for (const row of this.db.prepare('SELECT status, COUNT(*) AS n FROM alert_queue GROUP BY status').all()) result[row.status as AlertStatus] = Number(row.n);
    return result;
  }
}
