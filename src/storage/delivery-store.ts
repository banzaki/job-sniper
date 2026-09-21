import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import type { OpportunityKey } from '../domain/opportunity.js';
import { runInTransaction } from './db-util.js';

export type DeliveryKind = 'analysis' | 'demo';

export interface PartInput {
  label: string;
  /** Final HTML to send, stored so a resumed delivery sends exactly what was planned. */
  content: string;
  silent: boolean;
}

export interface DeliveryRow {
  id: number;
  kind: DeliveryKind;
  key: OpportunityKey;
  ref: string;
  variant: string;
  partCount: number;
  status: 'pending' | 'complete';
  createdAt: string;
  completedAt: string | null;
}

export interface PartRow {
  deliveryId: number;
  partNo: number;
  label: string;
  content: string;
  silent: boolean;
  status: 'pending' | 'sent';
  messageId: string | null;
  sentAt: string | null;
  attempts: number;
  lastError: string | null;
  /** The last attempt may or may not have reached the channel (timeout, lost reply). */
  ambiguous: boolean;
}

export interface DeliveryCounts {
  complete: number;
  incomplete: number;
  partsPending: number;
}

const MAX_ERROR_LENGTH = 500;

export class DeliveryDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeliveryDataError';
  }
}

/**
 * Persistent state of multi-part deliveries. A delivery is unique per (kind, opportunity, ref), each part
 * is confirmed on its own (with the channel's message id when available), and the delivery is complete only
 * when every part is. Restarting never resends a confirmed part.
 */
export class DeliveryStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  find(kind: DeliveryKind, key: OpportunityKey, ref: string): DeliveryRow | null {
    const row = this.db
      .prepare('SELECT * FROM deliveries WHERE kind = ? AND source_id = ? AND external_id = ? AND ref = ?')
      .get(kind, key.sourceId, key.externalId, ref);
    return row ? toDelivery(row) : null;
  }

  /** Creates the delivery and all its parts together. Throws if the same delivery already exists. */
  create(kind: DeliveryKind, key: OpportunityKey, ref: string, variant: string, parts: readonly PartInput[], at: string): DeliveryRow {
    if (parts.length === 0) throw new DeliveryDataError('A delivery needs at least one part.');
    return runInTransaction(this.db, () => {
      const result = this.db
        .prepare(
          `INSERT INTO deliveries (kind, source_id, external_id, ref, variant, part_count, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(kind, key.sourceId, key.externalId, ref, variant, parts.length, at);
      const id = Number(result.lastInsertRowid);
      const insertPart = this.db.prepare(
        'INSERT INTO delivery_parts (delivery_id, part_no, label, content, silent) VALUES (?, ?, ?, ?, ?)',
      );
      parts.forEach((part, index) => insertPart.run(id, index + 1, part.label, part.content, part.silent ? 1 : 0));
      const created = this.db.prepare('SELECT * FROM deliveries WHERE id = ?').get(id);
      if (!created) throw new DeliveryDataError('Delivery was not created.');
      return toDelivery(created);
    });
  }

  listIncomplete(kind?: DeliveryKind): DeliveryRow[] {
    const rows = kind
      ? this.db.prepare("SELECT * FROM deliveries WHERE status = 'pending' AND kind = ? ORDER BY id").all(kind)
      : this.db.prepare("SELECT * FROM deliveries WHERE status = 'pending' ORDER BY id").all();
    return rows.map(toDelivery);
  }

  parts(deliveryId: number): PartRow[] {
    return this.db
      .prepare('SELECT * FROM delivery_parts WHERE delivery_id = ? ORDER BY part_no')
      .all(deliveryId)
      .map(toPart);
  }

  markPartSent(deliveryId: number, partNo: number, messageId: string | null, at: string): void {
    this.db
      .prepare(
        `UPDATE delivery_parts SET status = 'sent', message_id = ?, sent_at = ?, attempts = attempts + 1,
           last_error = NULL, ambiguous = 0
         WHERE delivery_id = ? AND part_no = ? AND status = 'pending'`,
      )
      .run(messageId, at, deliveryId, partNo);
  }

  recordPartFailure(deliveryId: number, partNo: number, message: string, ambiguous: boolean): void {
    this.db
      .prepare(
        `UPDATE delivery_parts SET attempts = attempts + 1, last_error = ?, ambiguous = ?
         WHERE delivery_id = ? AND part_no = ? AND status = 'pending'`,
      )
      .run(message.slice(0, MAX_ERROR_LENGTH), ambiguous ? 1 : 0, deliveryId, partNo);
  }

  /** Marks the delivery complete only if every part was confirmed. Returns whether it is complete. */
  complete(deliveryId: number, at: string): boolean {
    const pending = this.db
      .prepare("SELECT COUNT(*) AS total FROM delivery_parts WHERE delivery_id = ? AND status <> 'sent'")
      .get(deliveryId)?.total;
    if (Number(pending) > 0) return false;
    this.db.prepare("UPDATE deliveries SET status = 'complete', completed_at = ? WHERE id = ? AND status = 'pending'").run(at, deliveryId);
    return true;
  }

  counts(): DeliveryCounts {
    const one = (sql: string): number => Number(this.db.prepare(sql).get()?.total ?? 0);
    return {
      complete: one("SELECT COUNT(*) AS total FROM deliveries WHERE status = 'complete'"),
      incomplete: one("SELECT COUNT(*) AS total FROM deliveries WHERE status = 'pending'"),
      partsPending: one(
        "SELECT COUNT(*) AS total FROM delivery_parts p JOIN deliveries d ON d.id = p.delivery_id WHERE p.status = 'pending' AND d.status = 'pending'",
      ),
    };
  }
}

function text(row: Record<string, SQLOutputValue>, column: string): string {
  const value = row[column];
  if (typeof value !== 'string') throw new DeliveryDataError(`Unexpected value in deliveries column "${column}".`);
  return value;
}

function nullableText(row: Record<string, SQLOutputValue>, column: string): string | null {
  return row[column] === null ? null : text(row, column);
}

function toDelivery(row: Record<string, SQLOutputValue>): DeliveryRow {
  return {
    id: Number(row.id),
    kind: text(row, 'kind') as DeliveryKind,
    key: { sourceId: text(row, 'source_id'), externalId: text(row, 'external_id') },
    ref: text(row, 'ref'),
    variant: text(row, 'variant'),
    partCount: Number(row.part_count),
    status: text(row, 'status') as DeliveryRow['status'],
    createdAt: text(row, 'created_at'),
    completedAt: nullableText(row, 'completed_at'),
  };
}

function toPart(row: Record<string, SQLOutputValue>): PartRow {
  return {
    deliveryId: Number(row.delivery_id),
    partNo: Number(row.part_no),
    label: text(row, 'label'),
    content: text(row, 'content'),
    silent: Number(row.silent) === 1,
    status: text(row, 'status') as PartRow['status'],
    messageId: nullableText(row, 'message_id'),
    sentAt: nullableText(row, 'sent_at'),
    attempts: Number(row.attempts),
    lastError: nullableText(row, 'last_error'),
    ambiguous: Number(row.ambiguous) === 1,
  };
}
