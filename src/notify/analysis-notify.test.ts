import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { ANALYSIS_VERSION } from '../ai/current-version.js';
import type { Opportunity } from '../domain/opportunity.js';
import { OpportunityStore } from '../storage/opportunity-store.js';
import { makeAnalysis, makeFilter, makeOpportunity, NOW, SOURCE } from '../testing/fixtures.js';
import { NotificationError, type Notifier, type SendOptions } from './notifier.js';
import { analysisDeliveryRef } from './deliver.js';
import { visibleLength } from './html.js';
import { notifyPending } from './notify-pending.js';
import { COMPACT_CEILING } from './present.js';

const workDir = mkdtempSync(join(tmpdir(), 'job-sniper-notify-'));
after(() => rmSync(workDir, { recursive: true, force: true }));

const decisions = ['shortlist', 'review'] as const;
const key = (id: string) => ({ sourceId: SOURCE, externalId: id });

interface Recorder extends Notifier {
  sent: { text: string; silent: boolean }[];
}

function recorder(failOn?: (number: number, text: string) => Error | null): Recorder {
  const sent: { text: string; silent: boolean }[] = [];
  let attempts = 0;
  return {
    sent,
    send: async (text: string, options: SendOptions = {}) => {
      attempts += 1;
      const failure = failOn?.(attempts, text);
      if (failure) throw failure;
      sent.push({ text, silent: options.silent === true });
      return { messageId: String(1000 + sent.length) };
    },
  };
}

function seed(id: string, over: Partial<Opportunity> = {}, decision: 'shortlist' | 'review' | 'skip' = 'shortlist', path = ':memory:') {
  const store = new OpportunityStore(path);
  const opportunity = makeOpportunity(id, over);
  store.insert(opportunity, makeFilter(decision), '2026-05-01T00:00:00.000Z');
  return { store, opportunity };
}

const notify = (store: OpportunityStore, notifier: Notifier, over: { dryRun?: boolean } = {}) =>
  notifyPending({ store, notifier, decisions, dryRun: over.dryRun ?? false, analysisVersion: ANALYSIS_VERSION, now: () => NOW });

test('a new opportunity with an analysis gets ONE compact message, with sound; both flags marked, delivery stored', async () => {
  const { store, opportunity } = seed('1');
  store.analyses.save(makeAnalysis(opportunity));
  const notifier = recorder();

  const report = await notify(store, notifier);
  assert.equal(notifier.sent.length, 1, 'exactly one message per opportunity');
  assert.equal(notifier.sent[0]!.silent, false);
  assert.match(notifier.sent[0]!.text, /VALE CANDIDATAR-SE/);
  assert.ok(!notifier.sent[0]!.text.includes('análise atualizada'));
  assert.ok(visibleLength(notifier.sent[0]!.text) <= COMPACT_CEILING);
  assert.ok(!/próximas mensagens|Detalhes|Rascunho/.test(notifier.sent[0]!.text));
  assert.deepEqual(report.kinds, { basic: 0, enriched: 1, aiUpdate: 0 });
  assert.equal(report.sent, 1);
  assert.equal(report.parts.sent, 1);
  assert.deepEqual(report.legacyDeliveries, []);
  assert.ok(store.get(key('1'))!.notifiedAt);
  assert.ok(store.analyses.get(key('1'), ANALYSIS_VERSION)!.notifiedAt);

  const delivery = store.deliveries.find('analysis', key('1'), analysisDeliveryRef(ANALYSIS_VERSION))!;
  assert.equal(delivery.status, 'complete');
  assert.equal(delivery.partCount, 1);
  assert.equal(store.deliveries.parts(delivery.id)[0]?.messageId, '1001');

  const second = await notify(store, notifier);
  assert.equal(second.pending, 0);
  assert.equal(second.parts.sent, 0);
  assert.equal(notifier.sent.length, 1, 'nothing is sent twice');
});

test('an analysis of an opportunity notified earlier is delivered once as "análise atualizada"', async () => {
  const { store, opportunity } = seed('1');
  store.markNotified(key('1'), '2026-04-30T00:00:00.000Z');
  store.analyses.save(makeAnalysis(opportunity));
  const notifier = recorder();

  const report = await notify(store, notifier);
  assert.deepEqual(report.kinds, { basic: 0, enriched: 0, aiUpdate: 1 });
  assert.match(notifier.sent[0]!.text, /análise atualizada/);
  assert.ok(!/notificad[oa] anteriormente|já foi enviad/i.test(notifier.sent[0]!.text), 'no long explanation about earlier notices');
  assert.equal(store.get(key('1'))!.notifiedAt, '2026-04-30T00:00:00.000Z', 'the first notification state is untouched');

  const count = notifier.sent.length;
  await notify(store, notifier);
  assert.equal(notifier.sent.length, count, 'the update is never sent twice');
});

test('without an analysis the basic pt-BR message is sent; the analysis that arrives later is sent once as an update', async () => {
  const { store, opportunity } = seed('1');
  const notifier = recorder();

  const first = await notify(store, notifier);
  assert.deepEqual(first.kinds, { basic: 1, enriched: 0, aiUpdate: 0 });
  assert.match(notifier.sent[0]!.text, /SELECIONADA/);
  assert.match(notifier.sent[0]!.text, /Motivo: sinais fortes: HTML/);
  assert.ok(!/Fit score|Access:|Source:/.test(notifier.sent[0]!.text), 'no English labels');

  store.analyses.save(makeAnalysis(opportunity));
  const second = await notify(store, notifier);
  assert.deepEqual(second.kinds, { basic: 0, enriched: 0, aiUpdate: 1 });
  const before = notifier.sent.length;
  const third = await notify(store, notifier);
  assert.equal(third.pending, 0);
  assert.equal(notifier.sent.length, before);
});

test('a clear AI skip is not announced, and it withholds the basic message too', async () => {
  const { store, opportunity } = seed('1');
  store.analyses.save(makeAnalysis(opportunity, { recommendation: 'skip', score: 12 }));
  const notifier = recorder();

  const report = await notify(store, notifier);
  assert.equal(report.pending, 0);
  assert.equal(report.suppressedBySkip, 1);
  assert.equal(notifier.sent.length, 0);
  assert.equal(store.get(key('1'))!.notifiedAt, null, 'the opportunity is not marked as notified');
});

test('an opportunity the basic filter skipped can still be announced when the AI finds it worth applying to', async () => {
  const { store, opportunity } = seed('1', {}, 'skip');
  store.analyses.save(makeAnalysis(opportunity));
  const notifier = recorder();
  const report = await notify(store, notifier);
  assert.deepEqual(report.kinds, { basic: 0, enriched: 0, aiUpdate: 1 });
  assert.equal(store.get(key('1'))!.notifiedAt, null);
});

test('dry-run renders the message but sends, stores and marks nothing', async () => {
  const { store, opportunity } = seed('1');
  store.analyses.save(makeAnalysis(opportunity));
  const notifier = recorder();
  const report = await notify(store, notifier, { dryRun: true });
  assert.equal(report.rendered, 1);
  assert.equal(report.sent, 0);
  assert.equal(notifier.sent.length, 1);
  assert.equal(store.get(key('1'))!.notifiedAt, null);
  assert.equal(store.analyses.get(key('1'), ANALYSIS_VERSION)!.notifiedAt, null);
  assert.deepEqual(store.deliveries.counts(), { complete: 0, incomplete: 0, partsPending: 0 }, 'no delivery is stored in dry-run');
  assert.equal((await notify(store, notifier, { dryRun: true })).pending, 1);
});

test('a failed send marks nothing; the next run sends the stored message once and then marks both flags', async () => {
  const { store, opportunity } = seed('1');
  store.analyses.save(makeAnalysis(opportunity));
  const failing = recorder((n) => (n === 1 ? new NotificationError('boom') : null));
  const report = await notify(store, failing);
  assert.equal(report.failures.length, 1);
  assert.equal(report.incompleteDeliveries, 1);
  assert.equal(failing.sent.length, 0);
  assert.equal(store.get(key('1'))!.notifiedAt, null);
  assert.equal(store.analyses.get(key('1'), ANALYSIS_VERSION)!.notifiedAt, null);
  const stored = store.deliveries.parts(1)[0]!;
  assert.equal(stored.status, 'pending');

  const good = recorder();
  const retry = await notify(store, good);
  assert.equal(retry.sent, 1);
  assert.equal(good.sent.length, 1);
  assert.equal(good.sent[0]!.text, stored.content, 'the stored message is what is sent');
  assert.ok(store.analyses.get(key('1'), ANALYSIS_VERSION)!.notifiedAt);
  assert.ok(store.get(key('1'))!.notifiedAt);
  assert.equal((await notify(store, good)).pending, 0);
  assert.equal(good.sent.length, 1);
});

test('restarting the process after a failed send resumes the same delivery, without a duplicate (file database)', async () => {
  const path = join(workDir, 'restart.db');
  const first = seed('1', {}, 'shortlist', path);
  first.store.analyses.save(makeAnalysis(first.opportunity));
  await notify(first.store, recorder((n) => (n === 1 ? new NotificationError('stopped') : null)));
  assert.equal(first.store.deliveries.counts().incomplete, 1);
  first.store.close();

  const reopened = new OpportunityStore(path);
  const after = recorder();
  const report = await notify(reopened, after);
  assert.equal(after.sent.length, 1);
  assert.equal(report.sent, 1);
  assert.equal(reopened.deliveries.counts().incomplete, 0);
  assert.equal(reopened.deliveries.counts().complete, 1, 'the same delivery, not a second one');
  reopened.close();
});

test('an ambiguous failure (timeout after a possible send) is recorded and not retried blindly in the same run', async () => {
  const { store, opportunity } = seed('1');
  store.analyses.save(makeAnalysis(opportunity));
  let calls = 0;
  const timeout: Notifier = {
    send: async () => {
      calls += 1;
      throw new NotificationError('timed out; delivery is unconfirmed', false, true);
    },
  };
  const report = await notify(store, timeout);
  assert.equal(calls, 1, 'no immediate blind repetition');
  assert.equal(report.failures[0]?.ambiguous, true);
  const part = store.deliveries.parts(1)[0]!;
  assert.equal(part.status, 'pending');
  assert.equal(part.ambiguous, true);
  assert.equal(store.analyses.get(key('1'), ANALYSIS_VERSION)!.notifiedAt, null);
});

test('a fatal error (bad credentials) stops the run and leaves everything pending', async () => {
  const seeded = ['1', '2'].map((id) => seed(id));
  const { store } = seeded[0]!;
  store.insert(makeOpportunity('2'), makeFilter(), '2026-05-01T00:00:00.000Z');
  store.analyses.save(makeAnalysis(makeOpportunity('1')));
  store.analyses.save(makeAnalysis(makeOpportunity('2')));
  let calls = 0;
  const fatal: Notifier = { send: async () => { calls += 1; throw new NotificationError('401', true); } };
  const report = await notify(store, fatal);
  assert.equal(calls, 1);
  assert.ok(report.aborted);
  assert.equal(store.analyses.listPendingNotification(ANALYSIS_VERSION).length, 2);
});

test('a delivery that was completed but never flagged (crash between the two steps) only gets its flags, no resend', async () => {
  const { store, opportunity } = seed('1');
  store.analyses.save(makeAnalysis(opportunity));
  const first = recorder();
  await notify(store, first);
  // Simulate the crash: the delivery is complete but the flags were not written.
  const db = (store as unknown as { db: import('node:sqlite').DatabaseSync }).db;
  db.prepare('UPDATE analyses SET notified_at = NULL').run();
  db.prepare('UPDATE opportunities SET notified_at = NULL').run();

  const second = recorder();
  const report = await notify(store, second);
  assert.equal(second.sent.length, 0, 'nothing is sent again');
  assert.equal(report.pending, 1);
  assert.ok(store.analyses.get(key('1'), ANALYSIS_VERSION)!.notifiedAt);
});

test('without an analysisVersion, analyses are ignored and behavior is exactly the basic notification', async () => {
  const { store, opportunity } = seed('1');
  store.analyses.save(makeAnalysis(opportunity, { recommendation: 'skip' }));
  const notifier = recorder();
  const report = await notifyPending({ store, notifier, decisions, dryRun: false, now: () => NOW });
  assert.deepEqual(report.kinds, { basic: 1, enriched: 0, aiUpdate: 0 });
});

test('"only" restricts delivery to the given opportunities and leaves the rest pending', async () => {
  const store = new OpportunityStore(':memory:');
  for (const id of ['1', '2', '3']) {
    const opportunity = makeOpportunity(id);
    store.insert(opportunity, makeFilter('shortlist'), '2026-05-01T00:00:00.000Z');
    store.markNotified(key(id), '2026-04-30T00:00:00.000Z');
    store.analyses.save(makeAnalysis(opportunity));
  }
  const notifier = recorder();
  const report = await notifyPending({ store, notifier, decisions: [], dryRun: false, analysisVersion: ANALYSIS_VERSION, only: [key('1'), key('3')], now: () => NOW });
  assert.equal(report.pending, 2);
  assert.equal(report.sent, 2);
  assert.ok(notifier.sent.every((message) => !message.text.includes('#2')), 'the other opportunity is untouched');
  assert.ok(store.analyses.get(key('1'), ANALYSIS_VERSION)!.notifiedAt);
  assert.equal(store.analyses.get(key('2'), ANALYSIS_VERSION)!.notifiedAt, null);

  const count = notifier.sent.length;
  const again = await notifyPending({ store, notifier, decisions: [], dryRun: false, analysisVersion: ANALYSIS_VERSION, only: [key('1'), key('3')], now: () => NOW });
  assert.equal(again.pending, 0);
  assert.equal(notifier.sent.length, count, 'no duplicate messages');
});

test('with no decisions, only analyses are announced: a pending basic notification is not sent', async () => {
  const { store, opportunity } = seed('1');
  store.analyses.save(makeAnalysis(opportunity));
  const notifier = recorder();
  const report = await notifyPending({ store, notifier, decisions: [], dryRun: false, analysisVersion: ANALYSIS_VERSION, now: () => NOW });
  assert.deepEqual(report.kinds, { basic: 0, enriched: 0, aiUpdate: 1 });
  assert.equal(store.get(key('1'))!.notifiedAt, null, 'the first (basic) notification state is untouched');
});

test('a presentation change never re-sends what was already confirmed: existing notified_at values keep the history quiet', async () => {
  const { store, opportunity } = seed('1');
  store.markNotified(key('1'), '2026-04-30T00:00:00.000Z');
  store.analyses.save(makeAnalysis(opportunity));
  store.analyses.markNotified(key('1'), ANALYSIS_VERSION, '2026-04-30T01:00:00.000Z');
  const notifier = recorder();
  const report = await notify(store, notifier);
  assert.equal(report.pending, 0);
  assert.equal(notifier.sent.length, 0);
});

/** A delivery planned in the former format: a summary plus a detail part, under the bare analysis version. */
function legacyDelivery(store: OpportunityStore, id: string, confirmed: number) {
  const delivery = store.deliveries.create(
    'analysis',
    key(id),
    ANALYSIS_VERSION,
    'enriched',
    [
      { label: 'Resumo', content: 'summary in the former format', silent: false },
      { label: 'Detalhes 2/2', content: 'details in the former format', silent: true },
    ],
    NOW.toISOString(),
  );
  if (confirmed > 0) store.deliveries.markPartSent(delivery.id, 1, '777', NOW.toISOString());
  return delivery;
}

test('a former multi-part delivery whose summary was sent is neither resumed nor announced again, and unsent parts are not marked as delivered', async () => {
  const { store, opportunity } = seed('1');
  store.analyses.save(makeAnalysis(opportunity));
  const legacy = legacyDelivery(store, '1', 1);
  const notifier = recorder();

  for (const dryRun of [true, false]) {
    const report = await notify(store, notifier, { dryRun });
    assert.equal(notifier.sent.length, 0, 'nothing is sent: no old detail part, no new message');
    assert.deepEqual(report.legacyDeliveries, [{ id: 'fake:1', partsSent: 1, partsTotal: 2, held: true }]);
    assert.equal(report.pending, 0);
    assert.equal(report.failures.length, 0);
  }
  const parts = store.deliveries.parts(legacy.id);
  assert.deepEqual(parts.map((part) => part.status), ['sent', 'pending'], 'the unsent part stays unsent');
  assert.equal(store.deliveries.find('analysis', key('1'), ANALYSIS_VERSION)?.status, 'pending', 'the old delivery is not marked complete');
  assert.equal(store.analyses.get(key('1'), ANALYSIS_VERSION)!.notifiedAt, null, 'no flag claims a delivery that did not happen');
  assert.equal(store.get(key('1'))!.notifiedAt, null);
  assert.equal(store.deliveries.find('analysis', key('1'), analysisDeliveryRef(ANALYSIS_VERSION)), null, 'no new delivery was created');
});

test('a former multi-part delivery of which nothing reached the owner is delivered in the compact format instead', async () => {
  const { store, opportunity } = seed('1');
  store.analyses.save(makeAnalysis(opportunity));
  const legacy = legacyDelivery(store, '1', 0);
  const notifier = recorder();

  const report = await notify(store, notifier);
  assert.deepEqual(report.legacyDeliveries, [{ id: 'fake:1', partsSent: 0, partsTotal: 2, held: false }]);
  assert.equal(notifier.sent.length, 1);
  assert.match(notifier.sent[0]!.text, /VALE CANDIDATAR-SE/);
  assert.ok(!/former format/.test(notifier.sent[0]!.text), 'the old stored parts are never sent');
  assert.deepEqual(store.deliveries.parts(legacy.id).map((part) => part.status), ['pending', 'pending']);
  assert.ok(store.analyses.get(key('1'), ANALYSIS_VERSION)!.notifiedAt);
});
