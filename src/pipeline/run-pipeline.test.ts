import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FilterResult } from '../domain/filter-result.js';
import type { Opportunity, OpportunitySummary } from '../domain/opportunity.js';
import { NotificationError, type Notifier } from '../notify/notifier.js';
import { notifyPending } from '../notify/notify-pending.js';
import { donBrunoProfile } from '../profile/don-bruno.js';
import type { ListingPage, OpportunitySource } from '../sources/opportunity-source.js';
import { SourceBlockedError } from '../sources/source-errors.js';
import { OpportunityStore } from '../storage/opportunity-store.js';
import { runPipeline, type PipelineOptions } from './run-pipeline.js';

const SOURCE = 'fake';
const NOW = new Date('2026-05-01T12:00:00.000Z');

function summary(id: string): OpportunitySummary {
  return {
    sourceId: SOURCE, externalId: id, title: `T${id}`, url: `https://x/${id}`,
    summary: null, publishedAt: null, discoveredAt: NOW.toISOString(),
  };
}

function opportunity(id: string): Opportunity {
  return {
    ...summary(id),
    description: 'Ajuste de landing page em HTML e CSS',
    access: { kind: 'public', publicAt: null, rawLabel: null },
    category: 'Web, Mobile & Software',
    subcategory: 'Desenvolvimento Web',
    experienceLevel: null, skills: [], budget: null, proposalCount: 1, interestedCount: 1,
    status: 'open', fetchedAt: NOW.toISOString(), sourceMetadata: {},
  };
}

interface FakeOptions {
  blockAtPage?: number;
  failAtPage?: number;
  /** Overrides the cursor returned after a given 1-based page. */
  nextCursorAfter?: Record<number, string | null>;
}

/** Pages are arrays of ids; the cursor is the 1-based page number, like a real source might use. */
class FakeSource implements OpportunitySource {
  readonly id = SOURCE;
  readonly listCalls: (string | null)[] = [];
  readonly detailCalls: string[] = [];

  constructor(private readonly pages: string[][], private readonly options: FakeOptions = {}) {}

  async listRecent(cursor: string | null = null): Promise<ListingPage> {
    this.listCalls.push(cursor);
    const page = cursor === null ? 1 : Number(cursor);
    if (page === this.options.blockAtPage) throw new SourceBlockedError('HTTP 429');
    if (page === this.options.failAtPage) throw new Error('listing exploded');
    const ids = this.pages[page - 1] ?? [];
    const natural = page < this.pages.length ? String(page + 1) : null;
    const nextCursor = page in (this.options.nextCursorAfter ?? {}) ? this.options.nextCursorAfter![page]! : natural;
    return { items: ids.map(summary), nextCursor };
  }

  async fetchDetail(externalId: string): Promise<Opportunity> {
    this.detailCalls.push(externalId);
    return opportunity(externalId);
  }
}

function setup(pages: string[][], fake: FakeOptions = {}, known: string[] = []) {
  const store = new OpportunityStore(':memory:');
  const oldFilter: FilterResult = { decision: 'skip', reasons: ['old'], matchedKeywords: [], evaluatedAt: 'e', ruleVersion: 'basic-v2' };
  for (const id of known) store.insert(opportunity(id), oldFilter, '2026-01-01T00:00:00.000Z');
  const source = new FakeSource(pages, fake);
  const run = (over: Partial<PipelineOptions> = {}) =>
    runPipeline({ source, store, profile: donBrunoProfile, maxDetailsPerRun: 10, maxPages: 5, targetNew: 10, now: () => NOW, ...over });
  return { store, source, run };
}

test('page 1 entirely known: goes on to page 2 and fetches details only for unseen items', async () => {
  const { store, source, run } = setup([['1', '2', '3'], ['4', '5', '6']], {}, ['1', '2', '3']);
  const report = await run();
  assert.equal(report.pagesScanned, 2);
  assert.equal(report.alreadyKnown, 3);
  assert.equal(report.unseenCollected, 3);
  assert.deepEqual(source.detailCalls, ['4', '5', '6']);
  assert.equal(report.persisted, 3);
  assert.equal(store.count(), 6);
  assert.equal(report.stopReason, 'source-exhausted');
});

test('known opportunities never trigger detail requests, only last_seen_at', async () => {
  const { store, source, run } = setup([['1', '2']], {}, ['1', '2']);
  const report = await run();
  assert.deepEqual(source.detailCalls, []);
  assert.equal(report.detailsRequested, 0);
  assert.equal(store.get({ sourceId: SOURCE, externalId: '1' })?.lastSeenAt, NOW.toISOString());
  assert.equal(store.get({ sourceId: SOURCE, externalId: '1' })?.firstSeenAt, '2026-01-01T00:00:00.000Z');
});

test('target reached before the page limit stops pagination', async () => {
  const { source, run } = setup([['1', '2', '3'], ['4', '5', '6'], ['7', '8', '9'], ['10', '11', '12']]);
  const report = await run({ targetNew: 4, maxPages: 5 });
  assert.equal(report.stopReason, 'target-new-reached');
  assert.equal(report.pagesScanned, 2);
  assert.deepEqual(source.listCalls, [null, '2']);
});

test('an empty page ends discovery', async () => {
  const { run } = setup([['1', '2'], []]);
  const report = await run();
  assert.equal(report.stopReason, 'source-exhausted');
  assert.equal(report.pagesScanned, 2);
  assert.equal(report.unseenCollected, 2);
});

test('a page repeating IDs already scanned in this run ends discovery (page=0 style repeat)', async () => {
  const { source, run } = setup([['1', '2'], ['1', '2'], ['3', '4']]);
  const report = await run();
  assert.equal(report.stopReason, 'repeated-page');
  assert.equal(report.discovered, 2);
  assert.deepEqual(source.detailCalls, ['1', '2']);
});

test('partial overlap between pages is normal: duplicates are collected once and discovery continues', async () => {
  const { source, run } = setup([['1', '2'], ['2', '3']]);
  const report = await run();
  assert.equal(report.stopReason, 'source-exhausted');
  assert.equal(report.discovered, 3);
  assert.deepEqual(source.detailCalls, ['1', '2', '3']);
});

test('a cursor that leads back to an already requested page makes no progress and stops', async () => {
  const { run } = setup([['1'], ['2'], ['3']], { nextCursorAfter: { 2: '2' } });
  const report = await run();
  assert.equal(report.stopReason, 'no-progress');
  assert.equal(report.pagesScanned, 2);
});

test('the page limit is respected even when nothing new is ever found', async () => {
  const known = ['1', '2', '3', '4', '5', '6', '7', '8'];
  const { source, run } = setup([['1', '2'], ['3', '4'], ['5', '6'], ['7', '8']], {}, known);
  const report = await run({ maxPages: 3 });
  assert.equal(report.stopReason, 'max-pages-reached');
  assert.equal(report.pagesScanned, 3);
  assert.equal(source.listCalls.length, 3);
  assert.deepEqual(source.detailCalls, []);
});

test('newest first: details follow scan order and the detail limit keeps the newest', async () => {
  const { source, store, run } = setup([['10', '9', '8'], ['7', '6', '5']]);
  const report = await run({ maxDetailsPerRun: 4 });
  assert.deepEqual(source.detailCalls, ['10', '9', '8', '7']);
  assert.deepEqual(report.processed.map((entry) => entry.opportunity.externalId), ['10', '9', '8', '7']);
  assert.equal(report.deferred, 2);
  assert.equal(store.has({ sourceId: SOURCE, externalId: '6' }), false);
});

test('deferred items are neither persisted nor duplicates: the next run picks them up, then nothing repeats', async () => {
  const { source, store, run } = setup([['1', '2', '3', '4']]);
  await run({ maxDetailsPerRun: 2 });
  source.detailCalls.length = 0;
  const second = await run({ maxDetailsPerRun: 2 });
  assert.equal(second.alreadyKnown, 2);
  assert.deepEqual(source.detailCalls, ['3', '4']);
  source.detailCalls.length = 0;
  const third = await run({ maxDetailsPerRun: 2 });
  assert.equal(third.detailsRequested, 0);
  assert.equal(store.count(), 4);
});

test('a block on a deeper page stops everything: no detail requests, earlier known items still marked as seen', async () => {
  const { source, store, run } = setup([['1', '2'], ['3', '4']], { blockAtPage: 2 }, ['1']);
  const report = await run();
  assert.equal(report.stopReason, 'blocked');
  assert.ok(report.aborted);
  assert.deepEqual(source.detailCalls, []);
  assert.equal(report.deferred, 1);
  assert.equal(store.get({ sourceId: SOURCE, externalId: '1' })?.lastSeenAt, NOW.toISOString());
  assert.equal(store.has({ sourceId: SOURCE, externalId: '2' }), false);
});

test('a non-block error on a deeper page keeps what was collected and still processes it', async () => {
  const { source, run } = setup([['1', '2'], ['3']], { failAtPage: 2 });
  const report = await run();
  assert.equal(report.stopReason, 'source-error');
  assert.match(report.stopDetail ?? '', /listing exploded/);
  assert.deepEqual(source.detailCalls, ['1', '2']);
  assert.equal(report.aborted, null);
});

test('notifications stay deduplicated across paginated runs and rediscovery', async () => {
  const { store, run } = setup([['1', '2'], ['3']]);
  await run();

  const sent: string[] = [];
  const notifier: Notifier = { send: async (text) => { sent.push(text); } };
  const decisions = ['shortlist', 'review'] as const;
  const first = await notifyPending({ store, notifier, decisions, dryRun: false, now: () => NOW });
  assert.equal(first.sent, 3);

  await run(); // everything is known now
  const second = await notifyPending({ store, notifier, decisions, dryRun: false, now: () => NOW });
  assert.equal(second.pending, 0);
  assert.equal(sent.length, 3);
});

test('a failed Telegram delivery keeps notified_at empty and is retried without touching the others', async () => {
  const { store, run } = setup([['1', '2']]);
  await run();
  let calls = 0;
  const flaky: Notifier = { send: async () => { calls += 1; if (calls === 1) throw new NotificationError('boom'); } };
  const report = await notifyPending({ store, notifier: flaky, decisions: ['shortlist'], dryRun: false, now: () => NOW });
  assert.equal(report.sent, 1);
  assert.equal(report.failures.length, 1);
  assert.equal(store.listPendingNotification(['shortlist']).length, 1);
});
