import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import { runInTransaction } from './db-util.js';

export type BeginResult =
  | { kind: 'ok'; used: number; limit: number }
  | { kind: 'wait'; waitMs: number }
  | { kind: 'cooldown'; until: string; cooldownKind: string | null; reason: string | null }
  | { kind: 'daily-limit'; used: number; limit: number };

export interface QuotaState {
  trackingStartedAt: string;
  cooldownUntil: string | null;
  cooldownKind: string | null;
  cooldownReason: string | null;
  lastRequestStartedAt: string | null;
}

export type LockResult =
  | { acquired: true; recovered: boolean }
  | { acquired: false; heldByPid: number; expiresAt: string };

/**
 * Local accounting of requests to a provider, plus a simple cross-process lock. The counter is what THIS app
 * observed and reserved, not the provider's official balance: it starts when this feature was first used and
 * cannot include earlier or external consumption.
 */
export class QuotaStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  /** Makes sure a state row exists, remembering when local tracking began. Returns that moment. */
  ensureTracking(provider: string, model: string, nowIso: string): string {
    this.db
      .prepare('INSERT OR IGNORE INTO quota_state (provider, model, tracking_started_at) VALUES (?, ?, ?)')
      .run(provider, model, nowIso);
    return this.state(provider, model)?.trackingStartedAt ?? nowIso;
  }

  state(provider: string, model: string): QuotaState | null {
    const row = this.db.prepare('SELECT * FROM quota_state WHERE provider = ? AND model = ?').get(provider, model);
    if (!row) return null;
    return {
      trackingStartedAt: text(row, 'tracking_started_at'),
      cooldownUntil: nullable(row, 'cooldown_until'),
      cooldownKind: nullable(row, 'cooldown_kind'),
      cooldownReason: nullable(row, 'cooldown_reason'),
      lastRequestStartedAt: nullable(row, 'last_request_started_at'),
    };
  }

  usage(provider: string, model: string, quotaDay: string): number {
    const row = this.db
      .prepare('SELECT attempts FROM quota_usage WHERE provider = ? AND model = ? AND quota_day = ?')
      .get(provider, model, quotaDay);
    return row ? Number(row.attempts) : 0;
  }

  /**
   * One atomic step before every request: refuses during a cooldown or once the daily limit is used up,
   * asks the caller to wait when the previous request started too recently, and otherwise RESERVES the
   * attempt (and records this start) before the call is made. Safe against concurrent processes.
   */
  beginRequest(params: {
    provider: string;
    model: string;
    quotaDay: string;
    dailyLimit: number;
    minIntervalMs: number;
    nowMs: number;
  }): BeginResult {
    const { provider, model, quotaDay, dailyLimit, minIntervalMs, nowMs } = params;
    const nowIso = new Date(nowMs).toISOString();
    return runInTransaction(
      this.db,
      () => {
        this.ensureTracking(provider, model, nowIso);
        const state = this.state(provider, model);
        if (state?.cooldownUntil && Date.parse(state.cooldownUntil) > nowMs) {
          return { kind: 'cooldown', until: state.cooldownUntil, cooldownKind: state.cooldownKind, reason: state.cooldownReason };
        }
        const used = this.usage(provider, model, quotaDay);
        if (used >= dailyLimit) return { kind: 'daily-limit', used, limit: dailyLimit };
        if (state?.lastRequestStartedAt) {
          const waitMs = Date.parse(state.lastRequestStartedAt) + minIntervalMs - nowMs;
          if (waitMs > 0) return { kind: 'wait', waitMs };
        }
        this.db
          .prepare(
            `INSERT INTO quota_usage (provider, model, quota_day, attempts, updated_at) VALUES (?, ?, ?, 1, ?)
             ON CONFLICT (provider, model, quota_day) DO UPDATE SET attempts = attempts + 1, updated_at = excluded.updated_at`,
          )
          .run(provider, model, quotaDay, nowIso);
        this.db
          .prepare('UPDATE quota_state SET last_request_started_at = ? WHERE provider = ? AND model = ?')
          .run(nowIso, provider, model);
        return { kind: 'ok', used: used + 1, limit: dailyLimit };
      },
      'immediate',
    );
  }

  setCooldown(provider: string, model: string, until: string, kind: string, reason: string, nowIso: string): void {
    this.ensureTracking(provider, model, nowIso);
    this.db
      .prepare('UPDATE quota_state SET cooldown_until = ?, cooldown_kind = ?, cooldown_reason = ? WHERE provider = ? AND model = ?')
      .run(until, kind, reason.slice(0, 300), provider, model);
  }

  clearCooldown(provider: string, model: string): void {
    this.db
      .prepare('UPDATE quota_state SET cooldown_until = NULL, cooldown_kind = NULL, cooldown_reason = NULL WHERE provider = ? AND model = ?')
      .run(provider, model);
  }

  /**
   * Takes the named lock, or recovers it when the holder is gone: expired, or its process no longer exists.
   * The same owner re-acquiring simply renews it.
   */
  acquireLock(name: string, owner: string, pid: number, nowMs: number, ttlMs: number, isAlive: (pid: number) => boolean): LockResult {
    return runInTransaction(
      this.db,
      () => {
        const row = this.db.prepare('SELECT * FROM run_locks WHERE name = ?').get(name);
        const expiresAt = new Date(nowMs + ttlMs).toISOString();
        const nowIso = new Date(nowMs).toISOString();
        if (row) {
          const holderPid = Number(row.pid);
          const stale = Date.parse(text(row, 'expires_at')) <= nowMs || !isAlive(holderPid);
          if (text(row, 'owner') !== owner && !stale) {
            return { acquired: false, heldByPid: holderPid, expiresAt: text(row, 'expires_at') };
          }
          this.db
            .prepare('UPDATE run_locks SET owner = ?, pid = ?, acquired_at = ?, expires_at = ? WHERE name = ?')
            .run(owner, pid, nowIso, expiresAt, name);
          return { acquired: true, recovered: text(row, 'owner') !== owner };
        }
        this.db
          .prepare('INSERT INTO run_locks (name, owner, pid, acquired_at, expires_at) VALUES (?, ?, ?, ?, ?)')
          .run(name, owner, pid, nowIso, expiresAt);
        return { acquired: true, recovered: false };
      },
      'immediate',
    );
  }

  renewLock(name: string, owner: string, nowMs: number, ttlMs: number): void {
    this.db
      .prepare('UPDATE run_locks SET expires_at = ? WHERE name = ? AND owner = ?')
      .run(new Date(nowMs + ttlMs).toISOString(), name, owner);
  }

  releaseLock(name: string, owner: string): void {
    this.db.prepare('DELETE FROM run_locks WHERE name = ? AND owner = ?').run(name, owner);
  }
}

function text(row: Record<string, SQLOutputValue>, column: string): string {
  const value = row[column];
  if (typeof value !== 'string') throw new Error(`Unexpected value in quota table column "${column}".`);
  return value;
}

function nullable(row: Record<string, SQLOutputValue>, column: string): string | null {
  return row[column] === null ? null : text(row, column);
}
