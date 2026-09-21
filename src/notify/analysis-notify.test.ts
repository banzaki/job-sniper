import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ANALYSIS_VERSION } from '../ai/current-version.js';
import type { Opportunity } from '../domain/opportunity.js';
import { OpportunityStore } from '../storage/opportunity-store.js';
import { makeAnalysis, makeFilter, makeOpportunity, NOW, SOURCE } from '../testing/fixtures.js';
import { formatAnalysisMessage } from './format-message.js';
import { NotificationError, type Notifier } from './notifier.js';
import { notifyPending } from './notify-pending.js';

const decisions = ['shortlist', 'review'] as const;
const key = (id: string) => ({ sourceId: SOURCE, externalId: id });

function recorder(): Notifier & { sent: string[] } {
  const sent: string[] = [];
  return { sent, send: async (text) => { sent.push(text); } };
}

function seed(id: string, over: Partial<Opportunity> = {}, decision: 'shortlist' | 'review' | 'skip' = 'shortlist') {
  const store = new OpportunityStore(':memory:');
  const opportunity = makeOpportunity(id, over);
  store.insert(opportunity, makeFilter(decision), '2026-05-01T00:00:00.000Z');
  return { store, opportunity };
}

const notify = (store: OpportunityStore, notifier: Notifier, over: { dryRun?: boolean } = {}) =>
  notifyPending({ store, notifier, decisions, dryRun: over.dryRun ?? false, analysisVersion: ANALYSIS_VERSION, now: () => NOW });

test('a new opportunity with an analysis gets ONE enriched message, and both states are marked', async () => {
  const { store, opportunity } = seed('1');
  store.analyses.save(makeAnalysis(opportunity));
  const notifier = recorder();

  const report = await notify(store, notifier);
  assert.equal(notifier.sent.length, 1);
  assert.deepEqual(report.kinds, { basic: 0, enriched: 1, aiUpdate: 0 });
  assert.match(notifier.sent[0]!, /^🟢 APPLY/);
  assert.ok(!notifier.sent[0]!.includes('AI update'));
  assert.ok(store.get(key('1'))!.notifiedAt);
  assert.ok(store.analyses.get(key('1'), ANALYSIS_VERSION)!.notifiedAt);

  const second = await notify(store, notifier);
  assert.equal(second.pending, 0);
  assert.equal(notifier.sent.length, 1, 'nothing is sent twice');
});

test('an analysis of an opportunity notified earlier is sent once, as a separate AI update', async () => {
  const { store, opportunity } = seed('1');
  store.markNotified(key('1'), '2026-04-30T00:00:00.000Z');
  store.analyses.save(makeAnalysis(opportunity));
  const notifier = recorder();

  const report = await notify(store, notifier);
  assert.deepEqual(report.kinds, { basic: 0, enriched: 0, aiUpdate: 1 });
  assert.match(notifier.sent[0]!, /AI update/);
  assert.equal(store.get(key('1'))!.notifiedAt, '2026-04-30T00:00:00.000Z', 'the first notification state is untouched');

  await notify(store, notifier);
  assert.equal(notifier.sent.length, 1, 'the update is never sent twice');
});

test('without an analysis the basic message is sent; the analysis that arrives later is sent once as an update', async () => {
  const { store, opportunity } = seed('1');
  const notifier = recorder();

  const first = await notify(store, notifier);
  assert.deepEqual(first.kinds, { basic: 1, enriched: 0, aiUpdate: 0 });
  assert.ok(!notifier.sent[0]!.includes('Score:'));

  store.analyses.save(makeAnalysis(opportunity));
  const second = await notify(store, notifier);
  assert.deepEqual(second.kinds, { basic: 0, enriched: 0, aiUpdate: 1 });
  const third = await notify(store, notifier);
  assert.equal(third.pending, 0);
  assert.equal(notifier.sent.length, 2, 'one basic message and one AI update, never repeated');
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
  assert.match(notifier.sent[0]!, /Filter \(basic-v2\): skip/);
  assert.equal(store.get(key('1'))!.notifiedAt, null);
});

test('dry-run renders messages but marks neither the opportunity nor the analysis', async () => {
  const { store, opportunity } = seed('1');
  store.analyses.save(makeAnalysis(opportunity));
  const notifier = recorder();
  const report = await notify(store, notifier, { dryRun: true });
  assert.equal(report.rendered, 1);
  assert.equal(report.sent, 0);
  assert.equal(store.get(key('1'))!.notifiedAt, null);
  assert.equal(store.analyses.get(key('1'), ANALYSIS_VERSION)!.notifiedAt, null);
  assert.equal((await notify(store, notifier, { dryRun: true })).pending, 1);
});

test('a failed delivery marks nothing, so the analysis notification is retried', async () => {
  const { store, opportunity } = seed('1');
  store.analyses.save(makeAnalysis(opportunity));
  const failing: Notifier = { send: async () => { throw new NotificationError('boom'); } };
  const report = await notify(store, failing);
  assert.equal(report.failures.length, 1);
  assert.equal(store.get(key('1'))!.notifiedAt, null);
  assert.equal(store.analyses.get(key('1'), ANALYSIS_VERSION)!.notifiedAt, null);
  const retry = await notify(store, recorder());
  assert.equal(retry.sent, 1);
});

test('without an analysisVersion, analyses are ignored and behavior is exactly the basic notification', async () => {
  const { store, opportunity } = seed('1');
  store.analyses.save(makeAnalysis(opportunity, { recommendation: 'skip' }));
  const notifier = recorder();
  const report = await notifyPending({ store, notifier, decisions, dryRun: false, now: () => NOW });
  assert.deepEqual(report.kinds, { basic: 1, enriched: 0, aiUpdate: 0 });
});

const restricted = (publicAt: string | null): Opportunity =>
  makeOpportunity('9', { access: { kind: 'premium_only', publicAt, rawLabel: 'Projeto Exclusivo. Ficará disponível para todos os profissionais em 23h52m30s.' } });

test('premium-only messages say WAIT — PREMIUM ONLY and show the estimated public time in Brasília time', () => {
  const opportunity = restricted('2026-05-02T17:00:00.000Z');
  const message = formatAnalysisMessage(opportunity, makeFilter(), makeAnalysis(opportunity), 'enriched', { sourceLabels: { fake: 'Fake' }, now: NOW });
  assert.match(message, /^🕒 WAIT — PREMIUM ONLY/);
  assert.match(message, /Access: restricted \(premium only\); estimated to open to everyone at 02\/05\/2026,? 14:00 \(Brasília\)\. Verify availability before applying\./);
  assert.match(message, /Fit score: 82\/100 \(technical fit, not a success probability\) · Confidence: high/);
  assert.match(message, /Source: Fake/);
});

test('an unknown opening time is stated as unknown, never invented', () => {
  const opportunity = restricted(null);
  const message = formatAnalysisMessage(opportunity, makeFilter(), makeAnalysis(opportunity), 'enriched', { now: NOW });
  assert.match(message, /opening time unknown/);
  assert.ok(!/estimated to open/.test(message));
});

test('a public opportunity shows public access and the other recommendation headers render', () => {
  const opportunity = makeOpportunity('1');
  assert.match(formatAnalysisMessage(opportunity, makeFilter(), makeAnalysis(opportunity), 'enriched'), /Access: public/);
  assert.match(formatAnalysisMessage(opportunity, makeFilter(), makeAnalysis(opportunity, { recommendation: 'review' }), 'enriched'), /^🟡 REVIEW/);
  assert.match(formatAnalysisMessage(opportunity, makeFilter(), makeAnalysis(opportunity, { recommendation: 'skip' }), 'enriched'), /^🔴 SKIP/);
});

test('analysis messages escape external text and stay far below Telegram\'s limit even with huge fields', () => {
  const opportunity = makeOpportunity('1', { title: '<b>Bold</b> & "quoted" ' + 'T'.repeat(600), url: 'https://example.test/?a=1&b=2' });
  const analysis = makeAnalysis(opportunity, {
    technicalFit: 'F'.repeat(800),
    matchedSkills: Array.from({ length: 12 }, (_, i) => `HTML${i} ${'m'.repeat(200)}`),
    missingSkills: ['<script>alert(1)</script>'],
    risks: Array.from({ length: 12 }, () => 'R'.repeat(290)),
    proposalText: 'Olá & bem-vindo <b>x</b>. ' + 'p'.repeat(1800),
  });
  const message = formatAnalysisMessage(opportunity, makeFilter(), analysis, 'enriched');
  assert.ok(message.length < 3500, String(message.length));
  assert.ok(!message.includes('<script>'));
  assert.ok(!message.includes('<b>Bold</b>'));
  assert.match(message, /&lt;script&gt;/);
  assert.match(message, /href="https:\/\/example\.test\/\?a=1&amp;b=2"/);
  assert.ok(!message.includes('T'.repeat(300)), 'title is truncated');
});

test('the message includes the proposal preview and never the opportunity description', () => {
  const opportunity = makeOpportunity('1', { description: 'DESCRIPTION-MUST-NOT-APPEAR' });
  const message = formatAnalysisMessage(opportunity, makeFilter(), makeAnalysis(opportunity), 'enriched');
  assert.match(message, /Proposal draft:\n<i>Olá! Li o briefing da landing page/);
  assert.ok(!message.includes('DESCRIPTION-MUST-NOT-APPEAR'));
  for (const label of ['Matches:', 'Missing:', 'Risks:', 'Effort:', 'Price:', 'Why:', 'Open opportunity']) {
    assert.ok(message.includes(label), label);
  }
  assert.match(message, /Price: R\$ 300–500/);
});

test('"only" restricts notification to the given opportunities and leaves the rest pending', async () => {
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
  assert.ok(notifier.sent.every((text) => !text.includes('Landing page 2')));
  assert.ok(store.analyses.get(key('1'), ANALYSIS_VERSION)!.notifiedAt);
  assert.equal(store.analyses.get(key('2'), ANALYSIS_VERSION)!.notifiedAt, null, 'the other one is untouched');

  const again = await notifyPending({ store, notifier, decisions: [], dryRun: false, analysisVersion: ANALYSIS_VERSION, only: [key('1'), key('3')], now: () => NOW });
  assert.equal(again.pending, 0);
  assert.equal(notifier.sent.length, 2, 'no duplicate messages');
});

test('with no decisions, only analyses are announced: a pending basic notification is not sent', async () => {
  const { store, opportunity } = seed('1');
  store.analyses.save(makeAnalysis(opportunity));
  const notifier = recorder();
  const report = await notifyPending({ store, notifier, decisions: [], dryRun: false, analysisVersion: ANALYSIS_VERSION, now: () => NOW });
  assert.deepEqual(report.kinds, { basic: 0, enriched: 0, aiUpdate: 1 });
  assert.equal(store.get(key('1'))!.notifiedAt, null, 'the first (basic) notification state is untouched');
});
