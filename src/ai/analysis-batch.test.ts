import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MatchAnalysis } from '../domain/match-analysis.js';
import type { Opportunity } from '../domain/opportunity.js';
import { brunoCandidate } from '../profile/bruno-candidate.js';
import { OpportunityStore } from '../storage/opportunity-store.js';
import { makeAnalysis, makeFilter, makeOpportunity, NOW, SOURCE } from '../testing/fixtures.js';
import type { AnalysisInput, OpportunityAnalyzer } from './analyzer.js';
import { planAnalyses, runAnalysisBatch } from './analysis-batch.js';
import { ANALYSIS_VERSION } from './current-version.js';
import {
  AnalysisInvalidOutputError,
  AnalysisQuotaError,
  AnalysisRejectedError,
  AnalysisUnavailableError,
} from './errors.js';

class FakeAnalyzer implements OpportunityAnalyzer {
  readonly id = 'fake';
  readonly model = 'fake-model';
  readonly calls: string[] = [];
  /** externalId -> error thrown for it */
  readonly failures = new Map<string, Error>();
  /** 1-based call number -> error thrown on that call */
  readonly failuresByCall = new Map<number, Error>();

  async analyze(input: AnalysisInput): Promise<MatchAnalysis> {
    this.calls.push(input.opportunity.externalId);
    const failure = this.failuresByCall.get(this.calls.length) ?? this.failures.get(input.opportunity.externalId);
    if (failure) throw failure;
    return makeAnalysis(input.opportunity);
  }
}

/** ids 1..count; a higher id is published later, so the newest is the highest id. */
function storeWith(count: number, over: (id: string) => Partial<Opportunity> = () => ({})): OpportunityStore {
  const store = new OpportunityStore(':memory:');
  for (let id = 1; id <= count; id += 1) {
    const opportunity = makeOpportunity(String(id), {
      publishedAt: `2026-04-01T00:${String(id).padStart(2, '0')}:00.000Z`,
      ...over(String(id)),
    });
    store.insert(opportunity, makeFilter(), `2026-04-01T00:${String(id).padStart(2, '0')}:00.000Z`);
  }
  return store;
}

const run = (store: OpportunityStore, analyzer: OpportunityAnalyzer, over: { limit?: number; force?: boolean; only?: { sourceId: string; externalId: string } } = {}) =>
  runAnalysisBatch({ store, analyzer, candidate: brunoCandidate, limit: over.limit ?? 20, now: () => NOW, ...(over.force ? { force: true } : {}), ...(over.only ? { only: over.only } : {}) });

/** The counters that matter for these tests (the rest of the shape is covered by the selection tests). */
const snapshot = (store: OpportunityStore) => {
  const { pending, success, failed } = store.analyses.counts(ANALYSIS_VERSION);
  return { pending, success, failed };
};

test('the batch never exceeds the limit of 20 and starts with the most recent', async () => {
  const store = storeWith(25);
  const analyzer = new FakeAnalyzer();
  const report = await run(store, analyzer);
  assert.equal(report.eligible, 25);
  assert.equal(report.attempted, 20);
  assert.equal(report.succeeded, 20);
  assert.equal(report.leftPending, 5);
  assert.equal(analyzer.calls[0], '25');
  assert.equal(new Set(analyzer.calls).size, 20, 'no opportunity is analyzed twice');
  assert.equal(store.analyses.counts(ANALYSIS_VERSION).pending, 5);
});

test('a smaller configured limit is respected', async () => {
  const analyzer = new FakeAnalyzer();
  const report = await run(storeWith(10), analyzer, { limit: 3 });
  assert.equal(report.attempted, 3);
  assert.equal(analyzer.calls.length, 3);
  assert.equal(analyzer.calls[0], '10');
});

test('quota exhaustion keeps completed analyses, leaves the rest pending, and records nothing against them', async () => {
  const store = storeWith(6);
  const analyzer = new FakeAnalyzer();
  analyzer.failuresByCall.set(3, new AnalysisQuotaError('quota', { kind: 'minute', retryAfterSeconds: 30, evidence: [] }));
  const report = await run(store, analyzer);

  assert.equal(report.stopReason, 'quota-exhausted');
  assert.equal(analyzer.calls.length, 3);
  assert.equal(report.succeeded, 2);
  assert.deepEqual(snapshot(store), { pending: 4, success: 2, failed: 0 });
  assert.ok(store.analyses.get({ sourceId: SOURCE, externalId: analyzer.calls[0]! }, ANALYSIS_VERSION));
  assert.equal(store.analyses.get({ sourceId: SOURCE, externalId: analyzer.calls[2]! }, ANALYSIS_VERSION), null);
});

test('a provider quota refusal saves a pause that survives restarts and is reported', async () => {
  const store = storeWith(3);
  const analyzer = new FakeAnalyzer();
  analyzer.failuresByCall.set(1, new AnalysisQuotaError('quota', { kind: 'minute', retryAfterSeconds: 30, evidence: ['GenerateRequestsPerMinutePerProjectPerModel'] }));
  const report = await run(store, analyzer);
  assert.equal(report.cooldownUntil, new Date(NOW.getTime() + 31_000).toISOString());
  const state = store.quota.state('fake', 'fake-model');
  assert.equal(state?.cooldownUntil, report.cooldownUntil);
  assert.match(state?.cooldownReason ?? '', /limite por minuto/);
});

test('a local refusal (daily limit or pause) does not create a new provider pause', async () => {
  const store = storeWith(2);
  const analyzer = new FakeAnalyzer();
  analyzer.failuresByCall.set(1, new AnalysisQuotaError('local limit', { kind: 'local-day', retryAfterSeconds: null, evidence: [] }, true));
  const report = await run(store, analyzer);
  assert.equal(report.stopReason, 'quota-exhausted');
  assert.equal(report.cooldownUntil, null);
  assert.equal(store.quota.state('fake', 'fake-model'), null);
});

test('a rejected request (bad key/model) stops the batch without blaming any opportunity', async () => {
  const store = storeWith(3);
  const analyzer = new FakeAnalyzer();
  analyzer.failuresByCall.set(1, new AnalysisRejectedError('HTTP 400'));
  const report = await run(store, analyzer);
  assert.equal(report.stopReason, 'provider-rejected');
  assert.equal(analyzer.calls.length, 1);
  assert.deepEqual(snapshot(store), { pending: 3, success: 0, failed: 0 });
});

test('a failed opportunity is recorded, stays pending, and does not stop the others', async () => {
  const store = storeWith(4);
  const analyzer = new FakeAnalyzer();
  analyzer.failures.set('3', new AnalysisInvalidOutputError('Invalid model output: bad score'));
  const report = await run(store, analyzer);

  assert.equal(report.succeeded, 3);
  assert.equal(report.failed, 1);
  assert.deepEqual(snapshot(store), { pending: 1, success: 3, failed: 1 });
  const failedRow = store.analyses.list(ANALYSIS_VERSION, 'failed')[0]!;
  assert.match(failedRow.errorMessage ?? '', /bad score/);
  assert.equal(failedRow.provider, 'fake');
  assert.equal(failedRow.model, 'fake-model');

  // The next run retries only the failed one, and success replaces the failure.
  analyzer.failures.clear();
  analyzer.calls.length = 0;
  const retry = await run(store, analyzer);
  assert.deepEqual(analyzer.calls, ['3']);
  assert.equal(retry.succeeded, 1);
  assert.deepEqual(snapshot(store), { pending: 0, success: 4, failed: 0 });
});

test('three consecutive outages end the batch; earlier successes are preserved', async () => {
  const store = storeWith(8);
  const analyzer = new FakeAnalyzer();
  for (const call of [2, 3, 4]) analyzer.failuresByCall.set(call, new AnalysisUnavailableError('down'));
  const report = await run(store, analyzer);
  assert.equal(report.stopReason, 'provider-unavailable');
  assert.equal(report.succeeded, 1);
  assert.equal(analyzer.calls.length, 4);
  assert.equal(store.analyses.counts(ANALYSIS_VERSION).success, 1);
});

test('the same analysis version is never repeated', async () => {
  const store = storeWith(3);
  const analyzer = new FakeAnalyzer();
  await run(store, analyzer);
  analyzer.calls.length = 0;
  const second = await run(store, analyzer);
  assert.equal(second.eligible, 0);
  assert.equal(second.attempted, 0);
  assert.deepEqual(analyzer.calls, []);
});

test('a new analysis version makes stored opportunities eligible again, and both versions coexist', async () => {
  const store = storeWith(2);
  await run(store, new FakeAnalyzer());
  assert.equal(store.analyses.select(ANALYSIS_VERSION, { limit: 20 }).totalEligible, 0);
  assert.equal(store.analyses.select('ai-v2', { limit: 20 }).totalEligible, 2);

  const opportunity = store.get({ sourceId: SOURCE, externalId: '1' })!.opportunity;
  store.analyses.save({ ...makeAnalysis(opportunity), analysisVersion: 'ai-v2' });
  assert.equal(store.analyses.select('ai-v2', { limit: 20 }).totalEligible, 1);
  assert.ok(store.analyses.get({ sourceId: SOURCE, externalId: '1' }, ANALYSIS_VERSION), 'v1 result is kept');
});

test('cancelled, closed and unknown-status opportunities are never analyzed, even when forced', async () => {
  const statuses: Record<string, Opportunity['status']> = { '1': 'open', '2': 'cancelled', '3': 'closed', '4': 'unknown', '5': 'open' };
  const store = storeWith(5, (id) => ({ status: statuses[id] ?? 'open' }));
  const analyzer = new FakeAnalyzer();
  await run(store, analyzer);
  assert.deepEqual([...analyzer.calls].sort(), ['1', '5']);
  analyzer.calls.length = 0;
  await run(store, analyzer, { force: true });
  assert.deepEqual([...analyzer.calls].sort(), ['1', '5']);
});

test('previously stored opportunities without the current analysis are eligible for backfill', async () => {
  const store = storeWith(3);
  store.analyses.save(makeAnalysis(store.get({ sourceId: SOURCE, externalId: '2' })!.opportunity));
  const analyzer = new FakeAnalyzer();
  await run(store, analyzer);
  assert.deepEqual([...analyzer.calls].sort(), ['1', '3']);
});

test('force replaces a successful analysis of the same version without touching its notification state', async () => {
  const store = storeWith(1);
  const analyzer = new FakeAnalyzer();
  await run(store, analyzer);
  const key = { sourceId: SOURCE, externalId: '1' };
  store.analyses.markNotified(key, ANALYSIS_VERSION, '2026-05-01T13:00:00.000Z');

  const forced = await run(store, analyzer, { force: true, only: key });
  assert.equal(forced.succeeded, 1);
  assert.equal(store.analyses.get(key, ANALYSIS_VERSION)?.notifiedAt, '2026-05-01T13:00:00.000Z');
  assert.equal(store.analyses.list(ANALYSIS_VERSION, 'success')[0]?.attempts, 2);
});

test('without force, saving over an existing successful analysis is refused', () => {
  const store = storeWith(1);
  const analysis = makeAnalysis(store.get({ sourceId: SOURCE, externalId: '1' })!.opportunity);
  store.analyses.save(analysis);
  assert.throws(() => store.analyses.save(analysis), /already exists/);
});

test('dry-run planning lists what would be analyzed and calls no provider', () => {
  const store = storeWith(25);
  const plan = planAnalyses(store, brunoCandidate, { limit: 20 });
  assert.equal(plan.eligible, 25);
  assert.equal(plan.keys.length, 20);
  assert.equal(plan.keys[0]?.externalId, '25');
  assert.equal(store.analyses.counts(ANALYSIS_VERSION).success, 0);
});
