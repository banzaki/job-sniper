import type { OpportunityStore } from '../storage/opportunity-store.js';
import { AnalysisQuotaError, type QuotaInfo } from './errors.js';

/** Injectable time source, so pacing, cooldowns and day changes can be tested without waiting. */
export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

const QUOTA_TIMEZONE = 'America/Los_Angeles';

/** The provider's quota day ("2026-03-08") for an instant: calendar date in America/Los_Angeles, DST included. */
export function quotaDayOf(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: QUOTA_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

/** The first instant of the next quota day. Found by search, so 23-hour and 25-hour days are handled. */
export function nextQuotaDayStart(date: Date): Date {
  const today = quotaDayOf(date);
  let low = date.getTime();
  let high = low + 26 * 3_600_000;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (quotaDayOf(new Date(middle)) === today) low = middle;
    else high = middle;
  }
  return new Date(high);
}

// ---------- reading a 429 ----------

function retryAfterFromHeader(value: string | null, nowMs: number): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, Math.ceil((at - nowMs) / 1000));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * Reads what the provider said about a 429: the Retry-After header, RetryInfo ("34s") and QuotaFailure
 * identifiers in the error details. The kind is named only when an identifier says so; otherwise "unknown".
 */
export function parseQuotaFailure(headers: Headers | null, body: unknown, nowMs: number): QuotaInfo {
  let retryAfter = retryAfterFromHeader(headers?.get('retry-after') ?? null, nowMs);
  const evidence: string[] = [];

  const details = asRecord(asRecord(body)?.error)?.details;
  if (Array.isArray(details)) {
    for (const detail of details) {
      const item = asRecord(detail);
      const type = typeof item?.['@type'] === 'string' ? item['@type'] : '';
      if (type.endsWith('RetryInfo') && typeof item?.retryDelay === 'string') {
        const seconds = Number.parseFloat(item.retryDelay);
        if (Number.isFinite(seconds) && retryAfter === null) retryAfter = Math.ceil(seconds);
      }
      if (type.endsWith('QuotaFailure') && Array.isArray(item?.violations)) {
        for (const violation of item.violations) {
          const entry = asRecord(violation);
          for (const field of ['quotaId', 'quotaMetric']) {
            const value = entry?.[field];
            if (typeof value === 'string' && value !== '') evidence.push(value);
          }
        }
      }
    }
  }

  const text = evidence.join(' ').toLowerCase().replace(/[_\s-]/g, '');
  let kind: QuotaInfo['kind'] = 'unknown';
  if (/perday|requestsperday/.test(text)) kind = 'day';
  else if (/token/.test(text)) kind = 'tokens';
  else if (/perminute/.test(text)) kind = 'minute';
  return { kind, retryAfterSeconds: retryAfter, evidence: [...new Set(evidence)] };
}

const KIND_LABEL: Record<QuotaInfo['kind'], string> = {
  minute: 'limite por minuto',
  tokens: 'limite de tokens por minuto',
  day: 'limite diário',
  unknown: 'limite não identificado',
  'local-day': 'limite diário local',
  cooldown: 'pausa ativa',
};

export function describeQuotaKind(kind: QuotaInfo['kind']): string {
  return KIND_LABEL[kind];
}

/**
 * How long to pause after a provider 429. Only the daily case uses the quota-day boundary, and only when the
 * provider named a per-day quota; an unidentified limit gets a short pause and never an invented daily reset.
 */
export function cooldownFor(info: QuotaInfo, now: Date): { until: Date; kind: string; reason: string } {
  const reason = describeQuotaKind(info.kind) + (info.evidence.length > 0 ? ` (${info.evidence[0]})` : '');
  if (info.kind === 'day') return { until: nextQuotaDayStart(now), kind: info.kind, reason };
  const seconds = info.retryAfterSeconds ?? (info.kind === 'unknown' ? 900 : 60);
  return { until: new Date(now.getTime() + (seconds + 1) * 1000), kind: info.kind, reason };
}

// ---------- the gate every request passes ----------

export interface QuotaGateOptions {
  provider: string;
  model: string;
  /** Most attempts per quota day, retries included. */
  dailyLimit: number;
  /** Minimum time between the START of two requests, retries included. */
  minIntervalMs: number;
  clock?: Clock;
}

/**
 * Called before EVERY request (a retry is another request). In one atomic step it refuses during a cooldown or
 * once the day's attempts are used up, waits when the previous request started too recently (also across
 * processes), and otherwise reserves the attempt and records the start, before anything is sent.
 * The counter is what this app observed: it started with this feature and is not the provider's balance.
 */
export class QuotaGate {
  private readonly clock: Clock;

  constructor(
    private readonly store: OpportunityStore,
    private readonly options: QuotaGateOptions,
  ) {
    this.clock = options.clock ?? realClock;
  }

  async beforeRequest(): Promise<void> {
    const { provider, model, dailyLimit, minIntervalMs } = this.options;
    for (;;) {
      const nowMs = this.clock.now();
      const result = this.store.quota.beginRequest({
        provider,
        model,
        quotaDay: quotaDayOf(new Date(nowMs)),
        dailyLimit,
        minIntervalMs,
        nowMs,
      });
      switch (result.kind) {
        case 'ok':
          return;
        case 'wait':
          await this.clock.sleep(result.waitMs);
          continue;
        case 'cooldown':
          throw new AnalysisQuotaError(
            `IA em pausa até ${result.until}${result.reason ? ` (${result.reason})` : ''}.`,
            { kind: 'cooldown', retryAfterSeconds: null, evidence: [] },
            true,
          );
        case 'daily-limit':
          throw new AnalysisQuotaError(
            `Limite diário local atingido: ${result.used} de ${result.limit} tentativas hoje (dia de cota em America/Los_Angeles).`,
            { kind: 'local-day', retryAfterSeconds: null, evidence: [] },
            true,
          );
      }
    }
  }
}

// ---------- exclusion between runs ----------

export interface LockOptions {
  name: string;
  owner: string;
  pid: number;
  ttlMs: number;
  clock?: Clock;
  isAlive?: (pid: number) => boolean;
}

/** True when a process with this pid exists (signal 0 only checks; it does not signal anything). */
export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Runs `work` while holding a named lock in the database, so two runs cannot overlap. A lock whose holder is
 * gone (expired, or its process no longer exists) is recovered instead of blocking forever.
 */
export async function withLock<T>(
  store: OpportunityStore,
  options: LockOptions,
  work: () => Promise<T>,
): Promise<{ acquired: true; recovered: boolean; result: T } | { acquired: false; heldByPid: number; expiresAt: string }> {
  const clock = options.clock ?? realClock;
  const lock = store.quota.acquireLock(options.name, options.owner, options.pid, clock.now(), options.ttlMs, options.isAlive ?? processIsAlive);
  if (!lock.acquired) return lock;
  try {
    return { acquired: true, recovered: lock.recovered, result: await work() };
  } finally {
    store.quota.releaseLock(options.name, options.owner);
  }
}
