import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { OpportunityAnalyzer } from './analyzer.js';
import { brunoCandidate } from '../profile/bruno-candidate.js';
import { OpportunityStore } from '../storage/opportunity-store.js';
import { makeAnalysis, makeFilter, makeOpportunity, validModelOutput } from '../testing/fixtures.js';
import { runAiStage } from './ai-stage.js';
import { AnalysisQuotaError, AnalysisUnavailableError } from './errors.js';
import { GeminiAnalyzer } from './gemini-analyzer.js';
import { cooldownFor, nextQuotaDayStart, parseQuotaFailure, QuotaGate, quotaDayOf, withLock, type Clock } from './quota.js';

const workDir = mkdtempSync(join(tmpdir(), 'job-sniper-quota-'));
after(() => rmSync(workDir, { recursive: true, force: true }));

/** Simulated time: sleeping just moves the clock, so no test waits for real seconds. */
class SimClock implements Clock {
  constructor(public t: number) {}
  now(): number { return this.t; }
  async sleep(ms: number): Promise<void> { this.t += ms; }
}

const at = (iso: string) => new SimClock(Date.parse(iso));
const P = 'gemini';
const M = 'gemini-3.6-flash';
const gate = (store: OpportunityStore, clock: Clock, over: { dailyLimit?: number; minIntervalMs?: number } = {}) =>
  new QuotaGate(store, { provider: P, model: M, dailyLimit: over.dailyLimit ?? 20, minIntervalMs: over.minIntervalMs ?? 15_000, clock });

// ---------- quota day: America/Los_Angeles, DST included ----------
test('the quota day follows America/Los_Angeles, not Brasília', () => {
  assert.equal(quotaDayOf(new Date('2026-01-15T07:59:00Z')), '2026-01-14', 'winter: LA midnight is 08:00 UTC');
  assert.equal(quotaDayOf(new Date('2026-01-15T08:00:00Z')), '2026-01-15');
  assert.equal(quotaDayOf(new Date('2026-07-15T06:59:00Z')), '2026-07-14', 'summer: LA midnight is 07:00 UTC');
  assert.equal(quotaDayOf(new Date('2026-07-15T07:00:00Z')), '2026-07-15');
  // Brasília midnight (03:00 UTC) is still the previous day for the provider.
  assert.equal(quotaDayOf(new Date('2026-01-15T03:30:00Z')), '2026-01-14');
});

test('the next quota day starts at the right instant across both daylight-saving changes', () => {
  assert.equal(nextQuotaDayStart(new Date('2026-01-15T12:00:00Z')).toISOString(), '2026-01-16T08:00:00.000Z');
  assert.equal(nextQuotaDayStart(new Date('2026-07-15T12:00:00Z')).toISOString(), '2026-07-16T07:00:00.000Z');
  // 2026-03-08: clocks jump forward, a 23-hour day (starts 08:00Z, next starts 07:00Z).
  assert.equal(nextQuotaDayStart(new Date('2026-03-08T12:00:00Z')).toISOString(), '2026-03-09T07:00:00.000Z');
  // 2026-11-01: clocks go back, a 25-hour day (starts 07:00Z, next starts 08:00Z).
  assert.equal(nextQuotaDayStart(new Date('2026-11-01T12:00:00Z')).toISOString(), '2026-11-02T08:00:00.000Z');
});

// ---------- pacing: 15 s between the START of requests ----------
test('requests are paced 15 s apart by the start time, through the persistent gate', async () => {
  const store = new OpportunityStore(':memory:');
  const clock = at('2026-05-01T12:00:00Z');
  const g = gate(store, clock);
  const starts: number[] = [];
  for (let i = 0; i < 4; i += 1) {
    await g.beforeRequest();
    starts.push(clock.now());
  }
  assert.deepEqual(starts.map((start, i) => (i === 0 ? 0 : start - starts[i - 1]!)), [0, 15_000, 15_000, 15_000]);
  assert.equal(store.quota.usage(P, M, quotaDayOf(new Date(clock.now()))), 4);
});

test('pacing is kept across processes: a second gate on the same database waits for the first one\'s last start', async () => {
  const store = new OpportunityStore(':memory:');
  const clock = at('2026-05-01T12:00:00Z');
  await gate(store, clock).beforeRequest();
  const before = clock.now();
  await gate(store, clock).beforeRequest();
  assert.equal(clock.now() - before, 15_000);
});

// ---------- the analyzer + gate: retries are requests too ----------
function geminiWith(store: OpportunityStore, clock: Clock, responses: (() => Response)[]) {
  const starts: number[] = [];
  let index = 0;
  const fakeFetch = (async () => {
    starts.push(clock.now());
    const next = responses[Math.min(index, responses.length - 1)]!;
    index += 1;
    return next();
  }) as typeof fetch;
  const analyzer = new GeminiAnalyzer('test-key-value', M, {
    fetch: fakeFetch, clock, gate: gate(store, clock), minIntervalMs: 15_000, retryDelayMs: 4_000, timeoutMs: 500,
  });
  return { analyzer, starts };
}
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const okResponse = () => json(200, { candidates: [{ content: { parts: [{ text: JSON.stringify(validModelOutput()) }] }, finishReason: 'STOP' }], modelVersion: M });
const input = () => ({ opportunity: makeOpportunity('1'), candidate: brunoCandidate, now: new Date('2026-05-01T12:00:00Z') });

test('the single retry is another request: it starts at least 15 s after the first and is counted', async () => {
  const store = new OpportunityStore(':memory:');
  const clock = at('2026-05-01T12:00:00Z');
  const { analyzer, starts } = geminiWith(store, clock, [() => json(503, { error: { message: 'busy' } }), okResponse]);
  await analyzer.analyze(input());
  assert.equal(starts.length, 2);
  assert.ok(starts[1]! - starts[0]! >= 15_000, `the retry started ${starts[1]! - starts[0]!} ms after the first request`);
  assert.deepEqual({ requests: analyzer.stats.requests, retries: analyzer.stats.retries }, { requests: 2, retries: 1 });
  assert.equal(store.quota.usage(P, M, quotaDayOf(new Date('2026-05-01T12:00:00Z'))), 2, 'both attempts were reserved');
});

test('the attempt is reserved BEFORE the call, so a request that then fails still counts', async () => {
  const store = new OpportunityStore(':memory:');
  const clock = at('2026-05-01T12:00:00Z');
  const { analyzer } = geminiWith(store, clock, [() => { throw new TypeError('network down'); }]);
  await assert.rejects(analyzer.analyze(input()), (error: unknown) => error instanceof AnalysisUnavailableError);
  assert.equal(store.quota.usage(P, M, quotaDayOf(new Date(clock.now()))), 2, 'the request and its retry');
});

// ---------- daily limit ----------
test('the daily limit is enforced from the reservation, persists across restarts, and resets on the LA day change', async () => {
  const path = join(workDir, 'daily.db');
  const clock = at('2026-01-14T20:00:00Z'); // LA 12:00 on 2026-01-14
  const first = new OpportunityStore(path);
  const g1 = gate(first, clock, { dailyLimit: 20, minIntervalMs: 0 });
  for (let i = 0; i < 20; i += 1) await g1.beforeRequest();
  await assert.rejects(g1.beforeRequest(), (error: unknown) => error instanceof AnalysisQuotaError && error.local && error.info?.kind === 'local-day');
  assert.equal(first.quota.usage(P, M, '2026-01-14'), 20, 'the refused 21st attempt was not counted');
  first.close();

  const reopened = new OpportunityStore(path);
  const g2 = gate(reopened, clock, { dailyLimit: 20, minIntervalMs: 0 });
  await assert.rejects(g2.beforeRequest(), /Limite diário local atingido: 20 de 20/);

  // Brasília midnight (03:00 UTC on the 15th) does NOT reset it: the provider's day is still 2026-01-14.
  clock.t = Date.parse('2026-01-15T03:30:00Z');
  await assert.rejects(g2.beforeRequest(), /Limite diário local atingido/);
  // LA midnight (08:00 UTC) does.
  clock.t = Date.parse('2026-01-15T08:00:00Z');
  await g2.beforeRequest();
  assert.equal(reopened.quota.usage(P, M, '2026-01-15'), 1);
  assert.equal(reopened.quota.usage(P, M, '2026-01-14'), 20, 'the previous day keeps its record');
  reopened.close();
});

test('two connections share one counter, so concurrent runs cannot exceed the limit together', async () => {
  const path = join(workDir, 'shared.db');
  const a = new OpportunityStore(path);
  const b = new OpportunityStore(path);
  const clock = at('2026-05-01T12:00:00Z');
  const gates = [gate(a, clock, { dailyLimit: 6, minIntervalMs: 0 }), gate(b, clock, { dailyLimit: 6, minIntervalMs: 0 })];
  let allowed = 0;
  let refused = 0;
  for (let i = 0; i < 12; i += 1) {
    try {
      await gates[i % 2]!.beforeRequest();
      allowed += 1;
    } catch {
      refused += 1;
    }
  }
  assert.deepEqual({ allowed, refused }, { allowed: 6, refused: 6 });
  a.close();
  b.close();
});

test('the local counter starts when this control first ran: it says so and claims no earlier history', async () => {
  const store = new OpportunityStore(':memory:');
  assert.equal(store.quota.state(P, M), null, 'nothing is recorded before the first request');
  const clock = at('2026-05-01T12:00:00Z');
  await gate(store, clock).beforeRequest();
  assert.equal(store.quota.state(P, M)?.trackingStartedAt, '2026-05-01T12:00:00.000Z');
  assert.equal(store.quota.usage(P, M, '2026-04-30'), 0, 'no invented history');
});

// ---------- reading a 429 ----------
const violation = (quotaId: string) => ({ error: { details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId, quotaMetric: 'generativelanguage.googleapis.com/x' }] }] } });

test('a 429 is classified only when the provider named the quota', () => {
  const now = Date.parse('2026-05-01T12:00:00Z');
  assert.equal(parseQuotaFailure(null, violation('GenerateRequestsPerDayPerProjectPerModel-FreeTier'), now).kind, 'day');
  assert.equal(parseQuotaFailure(null, violation('GenerateRequestsPerMinutePerProjectPerModel-FreeTier'), now).kind, 'minute');
  assert.equal(parseQuotaFailure(null, violation('GenerateContentInputTokensPerModelPerMinute-FreeTier'), now).kind, 'tokens');
  const unknown = parseQuotaFailure(null, { error: { message: 'You exceeded your current quota' } }, now);
  assert.equal(unknown.kind, 'unknown', 'no identifier, no claim');
  assert.deepEqual(unknown.evidence, []);
});

test('Retry-After (seconds or date) and RetryInfo are read when present', () => {
  const now = Date.parse('2026-05-01T12:00:00Z');
  assert.equal(parseQuotaFailure(new Headers({ 'retry-after': '42' }), null, now).retryAfterSeconds, 42);
  assert.equal(parseQuotaFailure(new Headers({ 'retry-after': new Date(now + 90_000).toUTCString() }), null, now).retryAfterSeconds, 90);
  const retryInfo = { error: { details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '34s' }] } };
  assert.equal(parseQuotaFailure(null, retryInfo, now).retryAfterSeconds, 34);
  assert.equal(parseQuotaFailure(new Headers({ 'retry-after': '5' }), retryInfo, now).retryAfterSeconds, 5, 'the header wins');
  assert.equal(parseQuotaFailure(null, {}, now).retryAfterSeconds, null);
});

test('cooldowns: a per-day quota waits for the LA day change; minute/token quotas use Retry-After; unknown never invents a daily reset', () => {
  const now = new Date('2026-05-01T12:00:00Z');
  const day = cooldownFor({ kind: 'day', retryAfterSeconds: null, evidence: ['PerDay'] }, now);
  assert.equal(day.until.toISOString(), nextQuotaDayStart(now).toISOString());
  assert.match(day.reason, /limite diário/);

  const minute = cooldownFor({ kind: 'minute', retryAfterSeconds: 30, evidence: [] }, now);
  assert.equal(minute.until.getTime() - now.getTime(), 31_000);
  assert.equal(cooldownFor({ kind: 'tokens', retryAfterSeconds: null, evidence: [] }, now).until.getTime() - now.getTime(), 61_000);

  const unknown = cooldownFor({ kind: 'unknown', retryAfterSeconds: null, evidence: [] }, now);
  assert.match(unknown.reason, /limite não identificado/);
  assert.equal(unknown.until.getTime() - now.getTime(), 901_000, 'a short pause');
  assert.ok(unknown.until.getTime() < nextQuotaDayStart(now).getTime(), 'no daily reset is assumed');
});

test('a 429 from the provider becomes a quota error with the evidence and no retry', async () => {
  const store = new OpportunityStore(':memory:');
  const clock = at('2026-05-01T12:00:00Z');
  const body = { error: { message: 'quota', details: [...violation('GenerateRequestsPerDayPerProjectPerModel-FreeTier').error.details, { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '20s' }] } };
  const { analyzer, starts } = geminiWith(store, clock, [() => json(429, body)]);
  await assert.rejects(analyzer.analyze(input()), (error: unknown) => {
    const quota = error as AnalysisQuotaError;
    return quota instanceof AnalysisQuotaError && !quota.local && quota.info?.kind === 'day' && quota.info.retryAfterSeconds === 20 && /limite diário/.test(quota.message);
  });
  assert.equal(starts.length, 1, 'never retried');
});

// ---------- cooldown persistence and the stage ----------
function storeWithPending(count: number, path = ':memory:'): OpportunityStore {
  const store = new OpportunityStore(path);
  for (let id = 1; id <= count; id += 1) store.insert(makeOpportunity(String(id)), makeFilter(), '2026-05-01T00:00:00.000Z');
  return store;
}

function countingAnalyzer(over: Partial<OpportunityAnalyzer> = {}): OpportunityAnalyzer & { calls: number } {
  const analyzer = {
    id: P,
    model: M,
    calls: 0,
    async analyze(inputArg: { opportunity: ReturnType<typeof makeOpportunity> }) {
      analyzer.calls += 1;
      return makeAnalysis(inputArg.opportunity);
    },
    ...over,
  };
  return analyzer as OpportunityAnalyzer & { calls: number };
}

test('after a provider 429 the pause survives a restart: the stage makes no request until it ends', async () => {
  const path = join(workDir, 'cooldown.db');
  const clock = at('2026-05-01T12:00:00Z');
  const first = storeWithPending(3, path);
  const limited = countingAnalyzer({
    async analyze() {
      throw new AnalysisQuotaError('quota', { kind: 'minute', retryAfterSeconds: 60, evidence: ['PerMinute'] });
    },
  });
  const ran = await runAiStage({ store: first, analyzer: limited, candidate: brunoCandidate, limit: 20, clock });
  assert.equal(ran.status, 'ran');
  assert.equal(ran.status === 'ran' && ran.batch.stopReason, 'quota-exhausted');
  first.close();

  const reopened = new OpportunityStore(path);
  const analyzer = countingAnalyzer();
  clock.t += 30_000;
  const paused = await runAiStage({ store: reopened, analyzer, candidate: brunoCandidate, limit: 20, clock });
  assert.equal(paused.status, 'paused');
  assert.equal(analyzer.calls, 0, 'no request while paused');
  assert.match(paused.status === 'paused' ? paused.reason ?? '' : '', /limite por minuto/);

  clock.t += 40_000; // past the pause
  const resumed = await runAiStage({ store: reopened, analyzer, candidate: brunoCandidate, limit: 20, clock });
  assert.equal(resumed.status, 'ran');
  assert.equal(analyzer.calls, 3);
  reopened.close();
});

test('two AI runs cannot overlap: the second one is refused while the first holds the lock', async () => {
  const store = storeWithPending(2);
  const clock = at('2026-05-01T12:00:00Z');
  let release: () => void = () => {};
  const blocker = new Promise<void>((resolve) => { release = resolve; });
  const slow = countingAnalyzer({
    async analyze(inputArg: { opportunity: ReturnType<typeof makeOpportunity> }) {
      await blocker;
      return makeAnalysis(inputArg.opportunity);
    },
  });
  const first = runAiStage({ store, analyzer: slow, candidate: brunoCandidate, limit: 1, clock, pid: 111, isAlive: () => true });

  const otherAnalyzer = countingAnalyzer();
  const second = await runAiStage({ store, analyzer: otherAnalyzer, candidate: brunoCandidate, limit: 1, clock, pid: 222, isAlive: () => true });
  assert.equal(second.status, 'locked');
  assert.equal(second.status === 'locked' && second.heldByPid, 111);
  assert.equal(otherAnalyzer.calls, 0);

  release();
  assert.equal((await first).status, 'ran');
  const third = await runAiStage({ store, analyzer: otherAnalyzer, candidate: brunoCandidate, limit: 1, clock, pid: 222, isAlive: () => true });
  assert.equal(third.status, 'ran', 'the lock was released when the first run ended');
});

test('a lock left by a run that ended unexpectedly is recovered: expired, or its process is gone', async () => {
  const store = storeWithPending(1);
  const clock = at('2026-05-01T12:00:00Z');
  const name = `ai:${P}:${M}`;
  const alive = () => true;
  const dead = () => false;

  // Held by a live process and not expired: refused.
  assert.equal(store.quota.acquireLock(name, 'other', 999, clock.now(), 60_000, alive).acquired, true);
  assert.equal(store.quota.acquireLock(name, 'mine', 1, clock.now() + 1000, 60_000, alive).acquired, false);
  // Its process is gone: recovered.
  const recoveredDead = store.quota.acquireLock(name, 'mine', 1, clock.now() + 1000, 60_000, dead);
  assert.deepEqual(recoveredDead, { acquired: true, recovered: true });
  // Expired: recovered even if the pid looks alive.
  const expired = store.quota.acquireLock(name, 'third', 2, clock.now() + 10 * 60_000, 60_000, alive);
  assert.deepEqual(expired, { acquired: true, recovered: true });
  // The same owner renews without "recovering".
  assert.deepEqual(store.quota.acquireLock(name, 'third', 2, clock.now() + 10 * 60_000 + 5, 60_000, alive), { acquired: true, recovered: false });
  store.quota.releaseLock(name, 'third');

  // The stage reports the recovery.
  store.quota.acquireLock(name, 'crashed', 4242, clock.now(), 60_000, alive);
  const analyzer = countingAnalyzer();
  const stage = await runAiStage({ store, analyzer, candidate: brunoCandidate, limit: 1, clock, pid: 1, isAlive: dead });
  assert.equal(stage.status === 'ran' && stage.recoveredLock, true);
});

test('withLock releases the lock even when the work throws', async () => {
  const store = new OpportunityStore(':memory:');
  const options = { name: 'x', owner: 'me', pid: 1, ttlMs: 60_000, clock: at('2026-05-01T12:00:00Z'), isAlive: () => true };
  await assert.rejects(withLock(store, options, async () => { throw new Error('boom'); }), /boom/);
  const again = await withLock(store, { ...options, owner: 'someone-else' }, async () => 'fine');
  assert.equal(again.acquired && again.result, 'fine');
});

test('with the AI paused by quota, collection and delivery of already saved analyses keep working', async () => {
  const { runPipeline } = await import('../pipeline/run-pipeline.js');
  const { notifyPending } = await import('../notify/notify-pending.js');
  const { donBrunoProfile } = await import('../profile/don-bruno.js');
  const { ANALYSIS_VERSION } = await import('./current-version.js');

  const store = new OpportunityStore(':memory:');
  const clock = at('2026-05-01T12:00:00Z');
  // An analysis saved earlier and not yet delivered, plus a pause from a recent quota refusal.
  const saved = makeOpportunity('1');
  store.insert(saved, makeFilter(), '2026-05-01T00:00:00.000Z');
  store.markNotified({ sourceId: 'fake', externalId: '1' }, '2026-04-30T00:00:00.000Z');
  store.analyses.save(makeAnalysis(saved));
  store.quota.setCooldown(P, M, new Date(clock.now() + 3_600_000).toISOString(), 'day', 'limite diário', new Date(clock.now()).toISOString());

  // 1. The AI stage is paused and makes no request.
  const analyzer = countingAnalyzer();
  const stage = await runAiStage({ store, analyzer, candidate: brunoCandidate, limit: 20, clock });
  assert.equal(stage.status, 'paused');
  assert.equal(analyzer.calls, 0);

  // 2. Collection still works.
  const source = {
    id: 'fake',
    listRecent: async () => ({ items: [{ sourceId: 'fake', externalId: '9', title: 'T9', url: 'https://x/9', summary: null, publishedAt: null, discoveredAt: 'd' }], nextCursor: null }),
    fetchDetail: async () => makeOpportunity('9'),
  };
  const report = await runPipeline({ source, store, profile: donBrunoProfile, maxDetailsPerRun: 5, maxPages: 3, targetNew: 100, now: () => new Date(clock.now()) });
  assert.equal(report.detailsObtained, 1);

  // 3. The saved analysis is still delivered.
  const sent: string[] = [];
  const delivery = await notifyPending({
    store, notifier: { send: async (text) => { sent.push(text); } }, decisions: [], dryRun: false,
    analysisVersion: ANALYSIS_VERSION, only: [{ sourceId: 'fake', externalId: '1' }], now: () => new Date(clock.now()),
  });
  assert.equal(delivery.sent, 1);
  assert.equal(sent.length, 1, 'one compact message');
  assert.ok(store.analyses.get({ sourceId: 'fake', externalId: '1' }, ANALYSIS_VERSION)!.notifiedAt);
});
