import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../config.js';
import type { Opportunity, OpportunitySummary } from '../domain/opportunity.js';
import { donBrunoProfile } from '../profile/don-bruno.js';
import type { SourceRun } from '../sources/create-sources.js';
import { createSourceRuns } from '../sources/create-sources.js';
import type { ListingPage, OpportunitySource } from '../sources/opportunity-source.js';
import { SourceBlockedError } from '../sources/source-errors.js';
import { OpportunityStore } from '../storage/opportunity-store.js';
import { AI_SOURCE_IDS, ANALYSIS_VERSION } from '../ai/current-version.js';
import { makeAnalysis, makeFilter, makeOpportunity } from '../testing/fixtures.js';
import { collectSources } from './collect-sources.js';
import { runPipeline } from './run-pipeline.js';

const NOW = new Date('2026-09-21T12:00:00.000Z');
const quiet = (): void => {};

class FakeSource implements OpportunitySource {
  readonly listCalls: (string | null)[] = [];
  readonly detailCalls: string[] = [];
  failListing: Error | null = null;

  constructor(readonly id: string, private readonly ids: string[]) {}

  async listRecent(cursor: string | null = null): Promise<ListingPage> {
    this.listCalls.push(cursor);
    if (this.failListing) throw this.failListing;
    return { items: this.ids.map((externalId) => this.summary(externalId)), nextCursor: null };
  }

  async fetchDetail(externalId: string): Promise<Opportunity> {
    this.detailCalls.push(externalId);
    return {
      ...this.summary(externalId),
      description: 'Ajuste de landing page em HTML e CSS',
      access: { kind: 'public', publicAt: null, rawLabel: null },
      category: 'Web, Mobile & Software',
      subcategory: 'Desenvolvimento Web',
      experienceLevel: null,
      skills: [],
      budget: null,
      proposalCount: null,
      interestedCount: null,
      status: 'open',
      fetchedAt: NOW.toISOString(),
      sourceMetadata: {},
    };
  }

  private summary(externalId: string): OpportunitySummary {
    return { sourceId: this.id, externalId, title: `${this.id} ${externalId}`, url: `https://${this.id}.example/${externalId}`, summary: null, publishedAt: null, discoveredAt: NOW.toISOString() };
  }
}

const run = (source: FakeSource, maxDetailsPerRun = 100): SourceRun => ({
  name: source.id as never,
  label: source.id,
  source,
  limits: { maxPages: 5, targetNew: 1000, maxDetailsPerRun },
  requestCount: () => 0,
  notes: () => [],
});

test('the same external id in two sources is two different opportunities, each kept under its own source', async () => {
  const store = new OpportunityStore(':memory:');
  const a = new FakeSource('alpha', ['1', '2']);
  const b = new FakeSource('beta', ['1', '2']);
  await collectSources([run(a), run(b)], store, donBrunoProfile, quiet);

  assert.equal(store.count(), 4);
  assert.ok(store.has({ sourceId: 'alpha', externalId: '1' }) && store.has({ sourceId: 'beta', externalId: '1' }));
  assert.equal(store.get({ sourceId: 'alpha', externalId: '1' })!.opportunity.url, 'https://alpha.example/1');
  assert.equal(store.get({ sourceId: 'beta', externalId: '1' })!.opportunity.url, 'https://beta.example/1');
  store.markNotified({ sourceId: 'alpha', externalId: '1' }, NOW.toISOString());
  assert.equal(store.get({ sourceId: 'beta', externalId: '1' })!.notifiedAt, null, 'a flag of one source never reaches the other');
});

test('each source works only on its own queue items and never asks its site for another source\'s jobs', async () => {
  const store = new OpportunityStore(':memory:');
  // Beta has pending work left from an earlier run (budget 0 was not possible, so leave it in the queue directly).
  store.queue.upsertDiscovered({ sourceId: 'beta', externalId: '77', title: 't', url: 'https://beta.example/77', summary: null, publishedAt: null, discoveredAt: NOW.toISOString() }, '2026-09-20T00:00:00.000Z');
  const alpha = new FakeSource('alpha', ['1']);
  await runPipeline({ source: alpha, store, profile: donBrunoProfile, maxPages: 1, targetNew: 10, maxDetailsPerRun: 50, now: () => NOW });

  assert.deepEqual(alpha.detailCalls, ['1'], 'alpha did not touch beta\'s pending item');
  assert.equal(store.queue.get({ sourceId: 'beta', externalId: '77' })!.state, 'pending');
  assert.equal(store.queue.listPending(NOW.toISOString(), 10, 'beta').length, 1);
  assert.equal(store.queue.listPending(NOW.toISOString(), 10, 'alpha').length, 0);
});

test('a source cannot consume another\'s budget: each run has its own limits', async () => {
  const store = new OpportunityStore(':memory:');
  const big = new FakeSource('alpha', Array.from({ length: 30 }, (_, i) => String(i + 1)));
  const small = new FakeSource('beta', ['1', '2', '3', '4']);
  const { outcomes } = await collectSources([run(big, 5), run(small, 3)], store, donBrunoProfile, quiet);

  assert.equal(outcomes[0]!.report!.detailsObtained, 5);
  assert.equal(outcomes[1]!.report!.detailsObtained, 3, 'beta still gets its own budget although alpha has 30 items');
  assert.equal(big.detailCalls.length, 5);
  assert.equal(small.detailCalls.length, 3);
  assert.equal(store.queue.counts().pending, 25 + 1);
});

test('a failing or blocked source is reported and the next one still runs', async () => {
  const store = new OpportunityStore(':memory:');
  const broken = new FakeSource('alpha', ['1']);
  broken.failListing = new SourceBlockedError('HTTP 429');
  const healthy = new FakeSource('beta', ['1', '2']);
  const lines: string[] = [];

  const { exitCode, outcomes } = await collectSources([run(broken), run(healthy)], store, donBrunoProfile, (line) => lines.push(line));
  assert.equal(exitCode, 2, 'the block is reported');
  assert.equal(outcomes[0]!.report!.stopReason, 'blocked');
  assert.equal(outcomes[1]!.report!.detailsObtained, 2, 'the healthy source was collected');
  assert.equal(store.count(), 2);
  assert.ok(lines.some((line) => line.includes('-- source: alpha --')) && lines.some((line) => line.includes('-- source: beta --')));

  broken.failListing = new Error('exploded');
  const again = await collectSources([run(broken), run(healthy)], store, donBrunoProfile, quiet);
  assert.equal(again.exitCode, 1);
  assert.equal(again.outcomes[0]!.report!.stopReason, 'source-error');
  assert.equal(again.outcomes[1]!.report!.alreadyKnown, 2);
});

test('an exception thrown out of a source does not stop the others either', async () => {
  const store = new OpportunityStore(':memory:');
  const throwing: SourceRun = { ...run(new FakeSource('alpha', ['1'])), source: { id: 'alpha', listRecent: () => { throw new Error('sync boom'); }, fetchDetail: async () => { throw new Error('unused'); } } };
  const healthy = new FakeSource('beta', ['1']);
  const { exitCode, outcomes } = await collectSources([throwing, run(healthy)], store, donBrunoProfile, quiet);
  assert.equal(exitCode, 1);
  assert.equal(outcomes[1]!.report!.detailsObtained, 1);
});

test('pending notifications of one source are untouched by a failing collection of another', async () => {
  const store = new OpportunityStore(':memory:');
  store.insert(makeOpportunity('9', { sourceId: 'beta' }), makeFilter(), '2026-09-20T00:00:00.000Z');
  const broken = new FakeSource('alpha', ['1']);
  broken.failListing = new Error('down');
  await collectSources([run(broken)], store, donBrunoProfile, quiet);
  assert.deepEqual(store.listPendingNotification(['shortlist', 'review']), [{ sourceId: 'beta', externalId: '9' }]);
});

// ---------- configuration ----------
test('sources default to 99Freelas alone, and the selection is validated', () => {
  assert.deepEqual(loadConfig({}, quiet).sources, ['99freelas']);
  assert.deepEqual(loadConfig({ SOURCES: '' }, quiet).sources, ['99freelas']);
  assert.deepEqual(loadConfig({ SOURCES: 'remotive' }, quiet).sources, ['remotive']);
  assert.deepEqual(loadConfig({ SOURCES: ' 99Freelas , Remotive ' }, quiet).sources, ['99freelas', 'remotive']);
  assert.deepEqual(loadConfig({ SOURCES: 'remotive,remotive' }, quiet).sources, ['remotive'], 'no duplicates');
  const warnings: string[] = [];
  assert.deepEqual(loadConfig({ SOURCES: 'workana,remotive' }, (message) => warnings.push(message)).sources, ['remotive']);
  assert.match(warnings[0]!, /unknown source "workana"/);
  assert.deepEqual(loadConfig({ SOURCES: 'workana' }, quiet).sources, ['99freelas'], 'nothing valid falls back to the default');
});

test('the Remotive interval defaults to 6 hours and can never be set lower', () => {
  assert.equal(loadConfig({ SOURCES: 'remotive' }, quiet).remotiveMinIntervalHours, 6);
  assert.equal(loadConfig({ SOURCES: 'remotive', REMOTIVE_MIN_INTERVAL_HOURS: '12' }, quiet).remotiveMinIntervalHours, 12);
  assert.throws(() => loadConfig({ SOURCES: 'remotive', REMOTIVE_MIN_INTERVAL_HOURS: '5' }, quiet), /REMOTIVE_MIN_INTERVAL_HOURS must be at least 6/);
  assert.throws(() => loadConfig({ SOURCES: 'remotive', REMOTIVE_MIN_INTERVAL_HOURS: 'abc' }, quiet), /positive integer/);
  // Not enabled: the variable is not even looked at, so a typo cannot break the default setup.
  assert.equal(loadConfig({ REMOTIVE_MIN_INTERVAL_HOURS: 'abc' }, quiet).remotiveMinIntervalHours, 6);
});

test('the default setup builds only the 99Freelas run; Remotive gets a single page and local details', () => {
  const store = new OpportunityStore(':memory:');
  assert.deepEqual(createSourceRuns(loadConfig({}, quiet), store).map((entry) => entry.name), ['99freelas']);
  const both = createSourceRuns(loadConfig({ SOURCES: '99freelas,remotive' }, quiet), store);
  assert.deepEqual(both.map((entry) => entry.name), ['99freelas', 'remotive']);
  assert.equal(both[1]!.limits.maxPages, 1);
  assert.equal(both[0]!.limits.maxPages, 20);
});

// ---------- the AI stage stays on 99Freelas ----------
test('automatic AI selection is limited to the sources it was written for; an explicit id still works', () => {
  const store = new OpportunityStore(':memory:');
  for (const [sourceId, id] of [['99freelas', '1'], ['remotive', '2']] as const) {
    store.insert(makeOpportunity(id, { sourceId }), makeFilter('shortlist'), '2026-09-20T00:00:00.000Z');
  }
  const keys = (options: object) => store.analyses.select(ANALYSIS_VERSION, { limit: 10, ...options }).keys.map((key) => `${key.sourceId}:${key.externalId}`);
  assert.deepEqual(keys({ sourceIds: AI_SOURCE_IDS }), ['99freelas:1']);
  assert.deepEqual(keys({}).sort(), ['99freelas:1', 'remotive:2'], 'without the restriction both are eligible');
  assert.deepEqual(keys({ sourceIds: AI_SOURCE_IDS, only: { sourceId: 'remotive', externalId: '2' } }), ['remotive:2']);
  assert.equal(store.analyses.counts(ANALYSIS_VERSION, AI_SOURCE_IDS).pending, 1);
  assert.equal(store.analyses.counts(ANALYSIS_VERSION).pending, 2);
  assert.deepEqual(keys({ sourceIds: [] }), [], 'an empty list selects nothing');
  assert.ok(makeAnalysis(makeOpportunity('1')));
});
