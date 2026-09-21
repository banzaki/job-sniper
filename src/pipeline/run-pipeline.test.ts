import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { FilterResult } from '../domain/filter-result.js';
import type { Opportunity, OpportunitySummary } from '../domain/opportunity.js';
import { NotificationError, type Notifier } from '../notify/notifier.js';
import { notifyPending } from '../notify/notify-pending.js';
import { donBrunoProfile } from '../profile/don-bruno.js';
import type { ListingPage, OpportunitySource } from '../sources/opportunity-source.js';
import { SourceBlockedError, SourceNotFoundError } from '../sources/source-errors.js';
import { OpportunityStore } from '../storage/opportunity-store.js';
import { runPipeline, splitDetailBudget, type PipelineOptions } from './run-pipeline.js';

const SOURCE = 'fake';
const NOW = new Date('2026-05-01T12:00:00.000Z');
const workDir = mkdtempSync(join(tmpdir(), 'job-sniper-pipeline-'));
after(() => rmSync(workDir, { recursive: true, force: true }));

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
  /** externalId -> what fetchDetail throws for it */
  readonly detailErrors = new Map<string, Error>();

  constructor(public pages: string[][], private readonly options: FakeOptions = {}) {}

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
    const failure = this.detailErrors.get(externalId);
    if (failure) throw failure;
    return opportunity(externalId);
  }
}

function setup(pages: string[][], fake: FakeOptions = {}, known: string[] = []) {
  const store = new OpportunityStore(':memory:');
  const oldFilter: FilterResult = { decision: 'skip', reasons: ['old'], matchedKeywords: [], evaluatedAt: 'e', ruleVersion: 'basic-v2' };
  for (const id of known) store.insert(opportunity(id), oldFilter, '2026-01-01T00:00:00.000Z');
  const source = new FakeSource(pages, fake);
  let clock = NOW;
  const run = (over: Partial<PipelineOptions> = {}) =>
    runPipeline({ source, store, profile: donBrunoProfile, maxDetailsPerRun: 10, maxPages: 5, targetNew: 100, now: () => clock, ...over });
  const advance = (ms: number) => { clock = new Date(clock.getTime() + ms); };
  return { store, source, run, advance };
}

test('page 1 entirely known: goes on to page 2 and fetches details only for the new summaries', async () => {
  const { store, source, run } = setup([['1', '2', '3'], ['4', '5', '6']], {}, ['1', '2', '3']);
  const report = await run();
  assert.equal(report.pagesScanned, 2);
  assert.equal(report.alreadyKnown, 3);
  assert.equal(report.newSummaries, 3);
  assert.deepEqual(source.detailCalls, ['4', '5', '6']);
  assert.equal(report.detailsObtained, 3);
  assert.equal(store.count(), 6);
  assert.equal(report.stopReason, 'source-exhausted');
});

test('known opportunities never trigger detail requests, only last_seen_at', async () => {
  const { store, source, run } = setup([['1', '2']], {}, ['1', '2']);
  const report = await run();
  assert.deepEqual(source.detailCalls, []);
  assert.equal(report.detailsAttempted, 0);
  assert.equal(store.get({ sourceId: SOURCE, externalId: '1' })?.lastSeenAt, NOW.toISOString());
  assert.equal(store.get({ sourceId: SOURCE, externalId: '1' })?.firstSeenAt, '2026-01-01T00:00:00.000Z');
});

test('the new-summary target stops pagination, and every summary of the pages already downloaded is still saved', async () => {
  const { store, source, run } = setup([['1', '2', '3'], ['4', '5', '6'], ['7', '8', '9'], ['10', '11', '12']]);
  const report = await run({ targetNew: 4, maxPages: 5, maxDetailsPerRun: 2 });
  assert.equal(report.stopReason, 'target-new-reached');
  assert.equal(report.pagesScanned, 2);
  assert.deepEqual(source.listCalls, [null, '2']);
  assert.equal(report.newSummaries, 6, 'the second page overshoots the target of 4, and its extra summaries are kept');
  assert.equal(store.queue.counts().pending + store.queue.counts().done, 6);
});

test('an empty page ends discovery', async () => {
  const { run } = setup([['1', '2'], []]);
  const report = await run();
  assert.equal(report.stopReason, 'source-exhausted');
  assert.equal(report.pagesScanned, 2);
  assert.equal(report.newSummaries, 2);
});

test('a page repeating IDs already scanned in this run ends discovery (page=0 style repeat)', async () => {
  const { source, run } = setup([['1', '2'], ['1', '2'], ['3', '4']]);
  const report = await run();
  assert.equal(report.stopReason, 'repeated-page');
  assert.equal(report.discovered, 2);
  assert.deepEqual(source.detailCalls, ['1', '2']);
});

test('overlapping pages do not duplicate registers: one queue row and one detail per id', async () => {
  const { store, source, run } = setup([['1', '2'], ['2', '3']]);
  const report = await run();
  assert.equal(report.stopReason, 'source-exhausted');
  assert.equal(report.discovered, 3);
  assert.equal(report.newSummaries, 3);
  assert.deepEqual(source.detailCalls, ['1', '2', '3']);
  assert.equal(store.queue.counts().done, 3);
  assert.equal(store.count(), 3);
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

test('counts are disjoint groups: discovered = known + new + already queued; attempted = obtained + failed + unavailable', async () => {
  const { store, source, run } = setup([['1', '2', '3', '4', '5']], {}, ['1']);
  store.queue.upsertDiscovered(summary('2'), '2026-04-01T00:00:00.000Z'); // queued before this run
  source.detailErrors.set('4', new Error('temporary'));
  const report = await run();
  assert.equal(report.alreadyKnown, 1);
  assert.equal(report.alreadyQueued, 1);
  assert.equal(report.newSummaries, 3);
  assert.equal(report.discovered, report.alreadyKnown + report.newSummaries + report.alreadyQueued);
  assert.equal(report.detailsAttempted, report.detailsObtained + report.detailsFailed + report.detailsUnavailable);
  assert.equal(report.detailsFailed, 1);
});

test('detail budget: new items go first in scan order, the rest stay pending in the queue (not lost)', async () => {
  const { store, source, run } = setup([['10', '9', '8'], ['7', '6', '5']]);
  const report = await run({ maxDetailsPerRun: 4 });
  assert.deepEqual(source.detailCalls, ['10', '9', '8', '7']);
  assert.deepEqual(report.processed.map((entry) => entry.opportunity.externalId), ['10', '9', '8', '7']);
  assert.equal(report.queue.pending, 2);
  assert.equal(store.has({ sourceId: SOURCE, externalId: '6' }), false);
  assert.equal(store.queue.get({ sourceId: SOURCE, externalId: '6' })?.state, 'pending');
});

test('the queue survives the item leaving the listing: older pending items advance while new ones arrive', async () => {
  const { store, source, run, advance } = setup([['1', '2', '3', '4']]);
  await run({ maxDetailsPerRun: 2 });
  assert.deepEqual(source.detailCalls, ['1', '2']);

  // Next run the listing shows only a new item: 3 and 4 already scrolled out of the pages.
  advance(3_600_000);
  source.detailCalls.length = 0;
  source.pages = [['5']];
  const second = await run({ maxDetailsPerRun: 2 });
  assert.deepEqual(source.detailCalls, ['5', '3'], 'one slot for the new item and the reserved slot for the oldest pending one');
  assert.equal(second.queue.pending, 1);

  advance(3_600_000);
  source.detailCalls.length = 0;
  source.pages = [['5']];
  await run({ maxDetailsPerRun: 2 });
  assert.deepEqual(source.detailCalls, ['4']);
  assert.equal(store.count(), 5);
});

test('a pending detail is not ignored just because its ID is already known to the queue', async () => {
  const { source, run, advance } = setup([['1', '2']]);
  await run({ maxDetailsPerRun: 1 });
  assert.deepEqual(source.detailCalls, ['1']);
  advance(60_000);
  source.detailCalls.length = 0;
  const second = await run({ maxDetailsPerRun: 5 });
  assert.equal(second.alreadyQueued, 1);
  assert.equal(second.newSummaries, 0);
  assert.deepEqual(source.detailCalls, ['2']);
});

test('the queue and its progress survive a process restart (file database)', async () => {
  const path = join(workDir, 'restart.db');
  const first = new OpportunityStore(path);
  const source = new FakeSource([['1', '2', '3', '4']]);
  const common = { source, profile: donBrunoProfile, maxPages: 5, targetNew: 100 };
  try {
    await runPipeline({ ...common, store: first, maxDetailsPerRun: 1, now: () => NOW });
  } finally {
    first.close();
  }

  const reopened = new OpportunityStore(path);
  try {
    assert.deepEqual(reopened.queue.counts(), { pending: 3, done: 1, unavailable: 0 });
    source.pages = [];
    source.detailCalls.length = 0;
    const later = new Date(NOW.getTime() + 3_600_000);
    const report = await runPipeline({ ...common, store: reopened, maxDetailsPerRun: 2, now: () => later });
    assert.equal(report.stopReason, 'source-exhausted');
    assert.deepEqual(source.detailCalls, ['2', '3'], 'the oldest pending items continue although nothing is listed anymore');
    assert.deepEqual(reopened.queue.counts(), { pending: 1, done: 3, unavailable: 0 });
  } finally {
    reopened.close();
  }
});

test('rediscovering a summary never resets finished work, notifications or failure history', async () => {
  const { store, run } = setup([['1']]);
  await run();
  store.markNotified({ sourceId: SOURCE, externalId: '1' }, '2026-05-01T13:00:00.000Z');
  const doneAt = store.queue.get({ sourceId: SOURCE, externalId: '1' })?.doneAt;
  assert.ok(doneAt);
  const report = await run();
  assert.equal(report.alreadyKnown, 1);
  assert.equal(store.queue.get({ sourceId: SOURCE, externalId: '1' })?.state, 'done');
  assert.equal(store.queue.get({ sourceId: SOURCE, externalId: '1' })?.doneAt, doneAt);
  assert.equal(store.get({ sourceId: SOURCE, externalId: '1' })?.notifiedAt, '2026-05-01T13:00:00.000Z');
});

test('splitDetailBudget shares the budget: half reserved for older items, leftovers flow to the other group', () => {
  const ids = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i}`);
  assert.deepEqual(splitDetailBudget(10, ids('n', 3), ids('o', 20)), [...ids('n', 3), ...ids('o', 7)]);
  assert.deepEqual(splitDetailBudget(10, ids('n', 20), ids('o', 20)), [...ids('n', 5), ...ids('o', 5)]);
  assert.deepEqual(splitDetailBudget(4, [], ids('o', 9)), ids('o', 4));
  assert.deepEqual(splitDetailBudget(5, ids('n', 9), ids('o', 9)), [...ids('n', 3), ...ids('o', 2)]);
  assert.deepEqual(splitDetailBudget(3, ids('n', 9), []), ids('n', 3));
  assert.deepEqual(splitDetailBudget(0, ids('n', 2), ids('o', 2)), []);
});

test('a temporary detail failure keeps the item pending and delays its retry; the retry then succeeds', async () => {
  const { store, source, run, advance } = setup([['1']]);
  source.detailErrors.set('1', new Error('timeout'));
  const first = await run();
  assert.equal(first.detailsFailed, 1);
  assert.equal(first.queue.pending, 1);
  const row = store.queue.get({ sourceId: SOURCE, externalId: '1' })!;
  assert.equal(row.attempts, 1);
  assert.ok(row.nextAttemptAt && Date.parse(row.nextAttemptAt) > NOW.getTime());

  source.detailCalls.length = 0;
  const tooSoon = await run();
  assert.equal(tooSoon.detailsAttempted, 0, 'still inside the retry delay');
  assert.deepEqual(source.detailCalls, []);

  advance(20 * 60_000);
  source.detailErrors.clear();
  const later = await run();
  assert.equal(later.detailsObtained, 1);
  assert.equal(store.queue.get({ sourceId: SOURCE, externalId: '1' })?.state, 'done');
});

test('repeated "not found" answers mark the item unavailable with its reason, and it is not retried forever', async () => {
  const { store, source, run, advance } = setup([['1']]);
  source.detailErrors.set('1', new SourceNotFoundError('page not accessible'));
  const first = await run();
  assert.equal(first.detailsFailed, 1, 'the first not-found is not yet proof');
  assert.equal(store.queue.get({ sourceId: SOURCE, externalId: '1' })?.state, 'pending');

  advance(20 * 60_000);
  const second = await run();
  assert.equal(second.detailsUnavailable, 1);
  const row = store.queue.get({ sourceId: SOURCE, externalId: '1' })!;
  assert.equal(row.state, 'unavailable');
  assert.match(row.unavailableReason ?? '', /page not accessible/);

  advance(48 * 3_600_000);
  source.detailCalls.length = 0;
  const third = await run();
  assert.equal(third.detailsAttempted, 0);
  assert.deepEqual(source.detailCalls, []);
  assert.equal(store.has({ sourceId: SOURCE, externalId: '1' }), false);
});

test('a block on a detail request stops everything and leaves that item pending, untouched', async () => {
  const { store, source, run } = setup([['1', '2', '3']]);
  source.detailErrors.set('2', new SourceBlockedError('HTTP 403'));
  const report = await run();
  assert.ok(report.aborted);
  assert.deepEqual(source.detailCalls, ['1', '2']);
  assert.equal(report.detailsObtained, 1);
  assert.equal(report.detailsAttempted, 1, 'the blocked request is not counted as an attempt against the item');
  const item = store.queue.get({ sourceId: SOURCE, externalId: '2' })!;
  assert.equal(item.state, 'pending');
  assert.equal(item.attempts, 0);
  assert.equal(store.queue.get({ sourceId: SOURCE, externalId: '3' })?.state, 'pending', 'saved before any detail, so it is kept');
});

test('a block on a deeper listing page stops everything: no detail requests, earlier summaries stay queued', async () => {
  const { store, source, run } = setup([['1', '2'], ['3', '4']], { blockAtPage: 2 }, ['1']);
  const report = await run();
  assert.equal(report.stopReason, 'blocked');
  assert.ok(report.aborted);
  assert.deepEqual(source.detailCalls, []);
  assert.equal(store.get({ sourceId: SOURCE, externalId: '1' })?.lastSeenAt, NOW.toISOString());
  assert.equal(store.queue.get({ sourceId: SOURCE, externalId: '2' })?.state, 'pending');
  assert.equal(store.queue.get({ sourceId: SOURCE, externalId: '3' }), null);
});

test('a non-block error on a deeper page keeps what was discovered and still processes it', async () => {
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
