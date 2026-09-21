import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import type { FilterDecision, FilterResult } from '../domain/filter-result.js';
import type { OpportunityKey } from '../domain/opportunity.js';
import type { Notifier } from '../notify/notifier.js';
import { NotificationError } from '../notify/notifier.js';
import { notifyPending } from '../notify/notify-pending.js';
import { SOURCE_LABELS } from '../notify/source-labels.js';
import { OpportunityStore } from '../storage/opportunity-store.js';
import { makeAnalysis, makeOpportunity } from '../testing/fixtures.js';
import { pickBacklog, viewBacklog } from './backlog.js';
import { selectAlertBatch } from './select-alert-batch.js';

const workDir = mkdtempSync(join(tmpdir(), 'job-sniper-batch-'));
after(() => rmSync(workDir, { recursive: true, force: true }));

const RUN = '2026-05-02T10:00:00.000Z'; // the instant the collection started
const NOW = new Date('2026-05-02T10:05:00.000Z');
const OLD = '2026-05-01T09:00:00.000Z'; // stored by an earlier collection
const NEW = '2026-05-02T10:01:00.000Z'; // stored by this collection
const ALL: readonly FilterDecision[] = ['top_match', 'shortlist', 'review'];
const CAP = 5;

let counter = 0;
/** Stores an opportunity as a collection would: decision, proposals and the instant it was first seen. */
function add(store: OpportunityStore, decision: FilterDecision, seenAt: string, proposals = 10, over: { sourceId?: string; fetchedAt?: string } = {}): OpportunityKey {
  counter += 1;
  const opportunity = makeOpportunity(`o${counter}`, {
    sourceId: over.sourceId ?? 'freelancer',
    title: `Project o${counter}`,
    employmentType: 'freelance',
    proposalCount: proposals,
    publishedAt: '2026-05-02T09:00:00.000Z',
    fetchedAt: over.fetchedAt ?? '2026-05-02T10:00:30.000Z',
  });
  const filter: FilterResult = { decision, reasons: ['strong signals: HTML'], matchedKeywords: ['HTML'], evaluatedAt: seenAt, ruleVersion: 'basic-v9' };
  store.insert(opportunity, filter, seenAt);
  return { sourceId: opportunity.sourceId, externalId: opportunity.externalId };
}
const ids = (keys: readonly OpportunityKey[]): string[] => keys.map((key) => key.externalId);
const select = (store: OpportunityStore, batchId = RUN, cap = CAP, now = NOW, decisions = ALL) => selectAlertBatch(store, { batchId, decisions, cap, now, maxAgeHoursBySource: { freelancer: 24 } });
const notified = (store: OpportunityStore): string[] => store.listKeys().filter((key) => store.get(key)!.notifiedAt !== null).map((key) => key.externalId);

function sender(failFirst = 0) {
  const sent: string[] = [];
  let calls = 0;
  const notifier: Notifier = {
    send: async (text) => {
      calls += 1;
      if (calls <= failFirst) throw new NotificationError('telegram is down', false, false);
      sent.push(/Project (\S+?)<\/b>/.exec(text)?.[1] ?? '?');
      return { messageId: `m${calls}` };
    },
  };
  return { notifier, sent };
}
const deliver = (store: OpportunityStore, notifier: Notifier, alertKeys: readonly OpportunityKey[], extra: { dryRun?: boolean } = {}) =>
  notifyPending({ store, notifier, decisions: ALL, dryRun: extra.dryRun ?? false, format: { sourceLabels: SOURCE_LABELS, now: NOW }, now: () => NOW, maxAlerts: CAP, maxAgeHoursBySource: { freelancer: 24 }, alertKeys });

test('only the opportunities stored by this collection compete: an old backlog of any size generates zero automatic alerts', async () => {
  const store = new OpportunityStore(':memory:');
  const backlog = [
    ...Array.from({ length: 41 }, () => add(store, 'shortlist', OLD)),
    ...Array.from({ length: 45 }, () => add(store, 'review', OLD)),
    add(store, 'top_match', OLD),
  ]; // 87 owed rows, all from earlier collections
  const before = notified(store);

  const batch = select(store);
  assert.equal(batch.selected.length, 0);
  assert.deepEqual(batch.alertKeys, []);
  assert.equal(batch.overflow, 0);
  assert.equal(batch.backlog, backlog.length, 'the backlog is still there, owed and consultable');
  assert.deepEqual(store.alertQueue.counts(), { selected: 0, overflow: 0, expired: 0 });

  const { notifier, sent } = sender();
  const report = await deliver(store, notifier, batch.alertKeys);
  assert.equal(report.sent, 0);
  assert.equal(sent.length, 0);
  assert.deepEqual(notified(store), before, 'no flag changed');
});

test('a new collection with more than 5 eligible: only the 5 best are selected, blue first, and the cap covers blue too', () => {
  const store = new OpportunityStore(':memory:');
  add(store, 'shortlist', OLD); // old: never competes
  const green = [add(store, 'shortlist', NEW, 10), add(store, 'shortlist', NEW, 20), add(store, 'shortlist', NEW, 30)];
  const yellow = [add(store, 'review', NEW, 5), add(store, 'review', NEW, 6), add(store, 'review', NEW, 7)];
  const blue = [add(store, 'top_match', NEW, 40), add(store, 'top_match', NEW, 50)];

  const batch = select(store);
  assert.deepEqual(batch.candidates, { top_match: 2, shortlist: 3, review: 3, skip: 0 });
  assert.equal(batch.selected.length, 5);
  assert.deepEqual(ids(batch.selected), [...ids(blue), ...ids(green)], 'top matches first, then the shortlist; the review does not fit');
  assert.equal(batch.overflow, 3);
  assert.deepEqual(batch.selectedByDecision, { top_match: 2, shortlist: 3, review: 0, skip: 0 });
  assert.deepEqual(store.alertQueue.counts(), { selected: 5, overflow: 3, expired: 0 });
  for (const key of yellow) assert.equal(store.alertQueue.get(key)?.status, 'overflow');

  // The cap is for blue too: seven blue, five selected.
  const other = new OpportunityStore(':memory:');
  const sevenBlue = Array.from({ length: 7 }, (_, i) => add(other, 'top_match', NEW, 10 + i));
  const b = select(other);
  assert.deepEqual(ids(b.selected), ids(sevenBlue.slice(0, 5)));
  assert.equal(b.overflow, 2);
});

test('the selection is persisted before anything is sent, survives a restart, and is idempotent for the same collection', () => {
  const path = join(workDir, 'persist.db');
  const first = new OpportunityStore(path);
  Array.from({ length: 8 }, (_, i) => add(first, 'shortlist', NEW, 10 + i));
  const batch = select(first);
  first.close();

  const reopened = new OpportunityStore(path);
  assert.deepEqual(ids(reopened.alertQueue.listSelectedPending(ALL)), ids(batch.selected));
  assert.deepEqual(reopened.alertQueue.get(batch.selected[0]!)?.batchId, RUN);
  // Running the selection again for the very same collection changes nothing and duplicates nothing.
  const again = select(reopened);
  assert.deepEqual(ids(again.carriedOver), ids(batch.selected), 'the same five, now carried over');
  assert.equal(again.selected.length, 0);
  assert.deepEqual(reopened.alertQueue.counts(), { selected: 5, overflow: 3, expired: 0 });
  reopened.close();
});

test('a delivery that fails keeps the same selected opportunities owed: the next run retries them, and only them', async () => {
  const store = new OpportunityStore(':memory:');
  const keys = Array.from({ length: 7 }, (_, i) => add(store, 'shortlist', NEW, 10 + i));
  const batch = select(store);
  const chosen = ids(batch.selected);
  assert.equal(chosen.length, 5);

  // Telegram is down for the whole run: nothing is marked, nothing is lost.
  const down = sender(99);
  const failed = await deliver(store, down.notifier, batch.alertKeys);
  assert.equal(failed.sent, 0);
  assert.ok(failed.failures.length > 0);
  assert.deepEqual(notified(store), [], 'notified_at untouched');
  assert.deepEqual(ids(store.alertQueue.listSelectedPending(ALL)), chosen, 'the same five are still owed');

  // The next run (later, with 3 brand new rows): the five come first, there is no room for the new ones.
  const NEXT = '2026-05-02T13:00:00.000Z';
  const later = add(store, 'top_match', '2026-05-02T13:00:20.000Z', 1, { fetchedAt: '2026-05-02T13:00:10.000Z' });
  add(store, 'shortlist', '2026-05-02T13:00:21.000Z', 1, { fetchedAt: '2026-05-02T13:00:10.000Z' });
  const retry = select(store, NEXT, CAP, new Date('2026-05-02T13:05:00.000Z'));
  assert.deepEqual(ids(retry.carriedOver), chosen, 'the same selected items, retried first');
  assert.equal(retry.selected.length, 0, 'no free slot: the cap holds even for a new blue');
  assert.equal(retry.overflow, 2);
  assert.equal(store.alertQueue.get(later)?.status, 'overflow');

  const up = sender();
  const ok = await notifyPending({ store, notifier: up.notifier, decisions: ALL, dryRun: false, format: { sourceLabels: SOURCE_LABELS, now: new Date('2026-05-02T13:05:00.000Z') }, now: () => new Date('2026-05-02T13:05:00.000Z'), maxAlerts: CAP, maxAgeHoursBySource: { freelancer: 24 }, alertKeys: retry.alertKeys });
  assert.equal(ok.sent, 5);
  assert.deepEqual([...up.sent].sort(), [...chosen].sort());
  assert.deepEqual(notified(store).sort(), [...chosen].sort());
  assert.deepEqual(keys.length, 7);
});

test('after a successful run the overflow is never drained by later runs: it stays saved, owed and consultable', async () => {
  const store = new OpportunityStore(':memory:');
  const collected = Array.from({ length: 12 }, (_, i) => add(store, i < 2 ? 'top_match' : i < 8 ? 'shortlist' : 'review', NEW, 10 + i));
  const batch = select(store);
  const first = sender();
  assert.equal((await deliver(store, first.notifier, batch.alertKeys)).sent, 5);
  const leftOut = collected.filter((key) => !batch.selected.some((k) => k.externalId === key.externalId));
  assert.equal(leftOut.length, 7);

  // Three later runs that find nothing new: none of them sends anything.
  for (const [n, run] of ['2026-05-02T14:00:00.000Z', '2026-05-02T15:00:00.000Z', '2026-05-02T16:00:00.000Z'].entries()) {
    const later = select(store, run, CAP, new Date(Date.parse(run) + 60_000));
    assert.equal(later.alertKeys.length, 0, `run ${n + 1} finds nothing owed automatically`);
    const sink = sender();
    const report = await notifyPending({ store, notifier: sink.notifier, decisions: ALL, dryRun: false, format: { sourceLabels: SOURCE_LABELS, now: NOW }, now: () => new Date(Date.parse(run) + 60_000), maxAlerts: CAP, alertKeys: later.alertKeys });
    assert.equal(report.sent, 0);
    assert.equal(sink.sent.length, 0);
  }
  assert.equal(notified(store).length, 5, 'still just the five delivered');
  assert.equal(store.alertQueue.counts().overflow, 7);
  assert.deepEqual(ids(store.alertQueue.listBacklog(ALL)).sort(), ids(leftOut).sort(), 'the seven are the backlog: owed, never alerted, undamaged');
  for (const key of leftOut) assert.equal(store.get(key)!.notifiedAt, null, 'not delivered, so not marked');
});

test('a selected item whose data went stale is released, and its slot goes to the new opportunities', () => {
  const store = new OpportunityStore(':memory:');
  const stale = Array.from({ length: 5 }, () => add(store, 'shortlist', NEW, 10));
  select(store);
  const LATER = '2026-05-04T10:00:00.000Z'; // two days on: the 24-hour data rule has expired
  const fresh = add(store, 'shortlist', '2026-05-04T10:00:20.000Z', 10, { fetchedAt: '2026-05-04T10:00:10.000Z' });
  const batch = select(store, LATER, CAP, new Date('2026-05-04T10:05:00.000Z'));
  assert.equal(batch.expired, 5);
  assert.equal(batch.carriedOver.length, 0);
  assert.deepEqual(ids(batch.selected), ids([fresh]));
  for (const key of stale) {
    assert.equal(store.alertQueue.get(key)?.status, 'expired');
    assert.equal(store.get(key)!.notifiedAt, null, 'expiring never marks a delivery');
  }
});

test('only wanted decisions compete, skip never does, and a decision change to skip releases a selected item', () => {
  const store = new OpportunityStore(':memory:');
  add(store, 'skip', NEW);
  const yellow = add(store, 'review', NEW);
  const green = add(store, 'shortlist', NEW);
  const onlyGreen = select(store, RUN, CAP, NOW, ['top_match', 'shortlist']);
  assert.deepEqual(ids(onlyGreen.selected), ids([green]));
  assert.equal(store.alertQueue.get(yellow), null, 'a decision that is not notified is not even recorded, and stays plain backlog-free storage');

  // The filter later re-evaluates the selected item to skip: it is no longer owed.
  store.updateFilters([{ key: green, filter: { decision: 'skip', reasons: ['x'], matchedKeywords: [], evaluatedAt: NOW.toISOString(), ruleVersion: 'basic-v9' } }]);
  assert.deepEqual(store.alertQueue.listSelectedPending(ALL), []);
});

test('notifyPending with an alert list sends only that list; without one it keeps its older behavior', async () => {
  const store = new OpportunityStore(':memory:');
  const inBatch = add(store, 'shortlist', NEW, 10);
  const backlog = add(store, 'top_match', OLD, 1);

  const sink = sender();
  const report = await deliver(store, sink.notifier, [inBatch]);
  assert.equal(report.sent, 1);
  assert.deepEqual(notified(store), [inBatch.externalId]);
  assert.equal(store.get(backlog)!.notifiedAt, null, 'the older blue is backlog: not sent, not marked');
  const none = await deliver(store, sink.notifier, []);
  assert.equal(none.sent, 0);

  const everything = await notifyPending({ store, notifier: sink.notifier, decisions: ALL, dryRun: false, format: { sourceLabels: SOURCE_LABELS, now: NOW }, now: () => NOW, maxAlerts: CAP });
  assert.equal(everything.sent, 1, 'no alert list: everything owed is considered, as before');
  assert.deepEqual(notified(store).sort(), [inBatch.externalId, backlog.externalId].sort());
});

test('DRY_RUN renders the batch and marks nothing; the selection stays owed for the live run', async () => {
  const store = new OpportunityStore(':memory:');
  const keys = Array.from({ length: 6 }, (_, i) => add(store, 'shortlist', NEW, 10 + i));
  const batch = select(store);
  const sink = sender();
  const dry = await deliver(store, sink.notifier, batch.alertKeys, { dryRun: true });
  assert.equal(dry.rendered, 5);
  assert.deepEqual(notified(store), []);
  assert.deepEqual(ids(store.alertQueue.listSelectedPending(ALL)), ids(batch.selected), 'still owed');
  const live = await deliver(store, sender().notifier, select(store).alertKeys);
  assert.equal(live.sent, 5);
  assert.equal(keys.length, 6);
});

test('an AI analysis never announces a backlog item, but an update for an already delivered one still goes out', async () => {
  const store = new OpportunityStore(':memory:');
  const backlogOpp = makeOpportunity('bk', { sourceId: '99freelas', title: 'Project bk', proposalCount: 3, fetchedAt: '2026-05-02T10:00:30.000Z' });
  store.insert(backlogOpp, { decision: 'shortlist', reasons: ['strong signals: HTML'], matchedKeywords: ['HTML'], evaluatedAt: OLD, ruleVersion: 'basic-v9' }, OLD);
  const deliveredOpp = makeOpportunity('dl', { sourceId: '99freelas', title: 'Project dl', proposalCount: 3, fetchedAt: '2026-05-02T10:00:30.000Z' });
  store.insert(deliveredOpp, { decision: 'shortlist', reasons: ['strong signals: HTML'], matchedKeywords: ['HTML'], evaluatedAt: OLD, ruleVersion: 'basic-v9' }, OLD);
  store.markNotified({ sourceId: '99freelas', externalId: 'dl' }, OLD);
  const backlogAnalysis = makeAnalysis(backlogOpp);
  const deliveredAnalysis = makeAnalysis(deliveredOpp);
  store.analyses.save(backlogAnalysis);
  store.analyses.save(deliveredAnalysis);

  const sink = sender();
  const report = await notifyPending({ store, notifier: sink.notifier, decisions: ALL, dryRun: false, analysisVersion: backlogAnalysis.analysisVersion, format: { sourceLabels: SOURCE_LABELS, now: NOW }, now: () => NOW, maxAlerts: CAP, alertKeys: [] });
  assert.equal(sink.sent.length, 1, 'only the update of the delivered one');
  assert.equal(report.kinds.aiUpdate, 1);
  assert.equal(store.get({ sourceId: '99freelas', externalId: 'bk' })!.notifiedAt, null, 'the backlog item was not announced through its analysis');
});

// ---------- the manual backlog ----------
test('the backlog is ranked, read only by default, and sent only by an explicit pick, never more than asked', async () => {
  const store = new OpportunityStore(':memory:');
  const oldGreen = add(store, 'shortlist', OLD, 40);
  const oldBlue = add(store, 'top_match', OLD, 50);
  const oldYellow = add(store, 'review', OLD, 5);
  const veryOld = add(store, 'shortlist', OLD, 10, { fetchedAt: '2026-04-20T10:00:00.000Z' }); // data too old to alert from
  const snapshot = (): string => JSON.stringify(store.listKeys().map((key) => store.get(key)!.notifiedAt));
  const before = snapshot();

  const view = viewBacklog(store, ALL, { now: NOW, maxAgeHoursBySource: { freelancer: 24 } });
  assert.equal(view.total, 4);
  assert.equal(view.stale, 1);
  assert.deepEqual(ids(view.ready.map((entry) => entry.key)), ids([oldBlue, oldGreen, oldYellow]), 'best first: blue, green, yellow');
  assert.equal(snapshot(), before, 'viewing changes nothing');
  assert.deepEqual(ids(pickBacklog(view, 2)), ids([oldBlue, oldGreen]));
  assert.deepEqual(pickBacklog(view, 0), []);

  // Sending is deliberate: exactly the picked items, and only what Telegram confirms is marked.
  const sink = sender();
  const picks = pickBacklog(view, 2);
  const report = await notifyPending({ store, notifier: sink.notifier, decisions: ALL, dryRun: false, format: { sourceLabels: SOURCE_LABELS, now: NOW }, now: () => NOW, maxAlerts: 2, only: picks, alertKeys: picks, maxAgeHoursBySource: { freelancer: 24 } });
  assert.equal(report.sent, 2);
  assert.deepEqual(notified(store).sort(), ids(picks).sort());
  assert.equal(store.get(oldYellow)!.notifiedAt, null);
  assert.equal(store.get(veryOld)!.notifiedAt, null);
  const next = viewBacklog(store, ALL, { now: NOW, maxAgeHoursBySource: { freelancer: 24 } });
  assert.deepEqual(ids(next.ready.map((entry) => entry.key)), ids([oldYellow]), 'what was sent leaves the backlog');
});

test('a selected item is never part of the backlog, and the listing of the store agrees', () => {
  const store = new OpportunityStore(':memory:');
  const selected = add(store, 'shortlist', NEW);
  const left = Array.from({ length: 6 }, () => add(store, 'review', NEW));
  select(store);
  const backlog = store.alertQueue.listBacklog(ALL);
  assert.ok(!backlog.some((key) => key.externalId === selected.externalId));
  assert.equal(backlog.length, left.length - 4, 'five selected in all, the rest is backlog');
  // Raw table check: the queue never holds a delivery flag of its own.
  const columns = (store as unknown as { db: DatabaseSync }).db.prepare('PRAGMA table_info(alert_queue)').all().map((row) => String(row.name));
  assert.ok(!columns.includes('notified_at'));
});
