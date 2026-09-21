import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { ConfigError, loadConfig } from '../config.js';
import type { FilterDecision, FilterResult } from '../domain/filter-result.js';
import type { OpportunityKey } from '../domain/opportunity.js';
import { selectAlertBatch } from '../pipeline/select-alert-batch.js';
import { OpportunityStore } from '../storage/opportunity-store.js';
import { makeAnalysis, makeOpportunity } from '../testing/fixtures.js';
import { dailyAllowance } from './daily-limit.js';
import { ownerDayWindow } from './day-window.js';
import type { Notifier } from './notifier.js';
import { notifyPending } from './notify-pending.js';
import { SOURCE_LABELS } from './source-labels.js';

const workDir = mkdtempSync(join(tmpdir(), 'job-sniper-daily-'));
after(() => rmSync(workDir, { recursive: true, force: true }));

const ALL: readonly FilterDecision[] = ['top_match', 'shortlist', 'review'];
const quiet = (): void => {};

// ---------- the calendar day of the owner ----------
test('a day is a calendar day in America/Sao_Paulo (UTC-3): it turns over at 03:00 UTC', () => {
  const before = ownerDayWindow(new Date('2026-09-21T02:59:59.999Z'));
  assert.deepEqual(before, { day: '2026-09-20', start: '2026-09-20T03:00:00.000Z', end: '2026-09-21T03:00:00.000Z' });
  const after = ownerDayWindow(new Date('2026-09-21T03:00:00.000Z'));
  assert.deepEqual(after, { day: '2026-09-21', start: '2026-09-21T03:00:00.000Z', end: '2026-09-22T03:00:00.000Z' });
  assert.equal(ownerDayWindow(new Date('2026-09-21T23:30:00.000Z')).day, '2026-09-21', '20:30 in Brasília');
  assert.equal(ownerDayWindow(new Date('2026-09-22T02:59:59.999Z')).day, '2026-09-21', 'still the same day');
  assert.equal(ownerDayWindow(new Date('2026-12-31T12:00:00.000Z')).end, '2027-01-01T03:00:00.000Z', 'the end of a year');
});

// ---------- configuration ----------
test('MAX_TELEGRAM_ALERTS_PER_DAY defaults to 10, accepts 1 to 1000 and fails clearly otherwise; the run limit is separate', () => {
  assert.equal(loadConfig({}, quiet).maxTelegramAlertsPerDay, 10);
  assert.equal(loadConfig({ MAX_TELEGRAM_ALERTS_PER_DAY: '  ' }, quiet).maxTelegramAlertsPerDay, 10);
  for (const value of [1, 25, 1000]) assert.equal(loadConfig({ MAX_TELEGRAM_ALERTS_PER_DAY: String(value) }, quiet).maxTelegramAlertsPerDay, value);
  for (const bad of ['0', '1001', '-5', '2.5', 'abc', '1e3']) {
    assert.throws(() => loadConfig({ MAX_TELEGRAM_ALERTS_PER_DAY: bad }, quiet), (error: unknown) => error instanceof ConfigError && error.message.includes('MAX_TELEGRAM_ALERTS_PER_DAY'), bad);
  }
  assert.equal(loadConfig({ MAX_TELEGRAM_ALERTS_PER_RUN: '7' }, quiet).maxTelegramAlertsPerRun, 7);
  assert.equal(loadConfig({}, quiet).maxTelegramAlertsPerRun, 5);
});

test('DISPLAY_CURRENCY defaults to USD, is a 3-letter code (any case) and fails clearly otherwise', () => {
  assert.equal(loadConfig({}, quiet).displayCurrency, 'USD');
  assert.equal(loadConfig({ DISPLAY_CURRENCY: ' brl ' }, quiet).displayCurrency, 'BRL');
  for (const bad of ['US', 'DOLLAR', '123', 'U$D']) {
    assert.throws(() => loadConfig({ DISPLAY_CURRENCY: bad }, quiet), (error: unknown) => error instanceof ConfigError && error.message.includes('DISPLAY_CURRENCY'), bad);
  }
});

// ---------- the count ----------
let counter = 0;
function add(store: OpportunityStore, decision: FilterDecision, seenAt: string, proposals = 10, fetchedAt = seenAt): OpportunityKey {
  counter += 1;
  const opportunity = makeOpportunity(`d${counter}`, { sourceId: 'freelancer', title: `Project d${counter}`, employmentType: 'freelance', proposalCount: proposals, publishedAt: seenAt, fetchedAt });
  const filter: FilterResult = { decision, reasons: ['strong signals: HTML'], matchedKeywords: ['HTML'], evaluatedAt: seenAt, ruleVersion: 'basic-v10' };
  store.insert(opportunity, filter, seenAt);
  return { sourceId: opportunity.sourceId, externalId: opportunity.externalId };
}
const ids = (keys: readonly OpportunityKey[]): string[] => keys.map((key) => key.externalId);
/** An automatic alert already delivered: a collection selected it and Telegram confirmed it. */
function autoSent(store: OpportunityStore, at: string, decision: FilterDecision = 'shortlist'): OpportunityKey {
  const key = add(store, decision, at);
  store.alertQueue.record(`batch-${at}`, at, [{ key, status: 'selected', rank: 1, decision }]);
  store.markNotified(key, at);
  return key;
}
/** A manual real delivery already made: never selected by a collection. */
function manualSent(store: OpportunityStore, at: string): OpportunityKey {
  const key = add(store, 'shortlist', at);
  store.markNotified(key, at);
  return key;
}

test('the day count is automatic alerts only: it turns over at midnight, and manual sends, previews and AI updates do not use it', () => {
  const store = new OpportunityStore(':memory:');
  const yesterday = '2026-09-20T15:00:00.000Z'; // 12:00 on the 20th in Brasília
  const today = '2026-09-21T15:00:00.000Z';
  for (let i = 0; i < 3; i += 1) autoSent(store, yesterday);
  for (let i = 0; i < 4; i += 1) autoSent(store, today);
  add(store, 'shortlist', today); // owed, not confirmed: not counted
  const noon = new Date('2026-09-21T16:00:00.000Z');
  const clean = { manualDeliveries: 0, manualPreviews: 0 };
  assert.deepEqual(dailyAllowance(store, noon, 10), { cap: 10, day: '2026-09-21', automaticToday: 4, remaining: 6, ...clean });
  assert.deepEqual(dailyAllowance(store, new Date('2026-09-20T18:00:00.000Z'), 10), { cap: 10, day: '2026-09-20', automaticToday: 3, remaining: 7, ...clean });
  assert.deepEqual(dailyAllowance(store, new Date('2026-09-22T12:00:00.000Z'), 10), { cap: 10, day: '2026-09-22', automaticToday: 0, remaining: 10, ...clean }, 'the next day starts empty');
  assert.equal(dailyAllowance(store, noon, 4).remaining, 0);
  assert.equal(dailyAllowance(store, noon, 2).remaining, 0, 'never negative');

  // Manual real deliveries are counted apart and never reduce what the automatic alerts may use.
  for (let i = 0; i < 6; i += 1) manualSent(store, today);
  const withManual = dailyAllowance(store, noon, 10);
  assert.equal(withManual.automaticToday, 4);
  assert.equal(withManual.remaining, 6, 'six manual deliveries did not consume the automatic limit');
  assert.equal(withManual.manualDeliveries, 6);

  // An AI update of an opportunity announced earlier is not an automatic alert either.
  const announced = autoSent(store, yesterday);
  store.analyses.save(makeAnalysis(store.get(announced)!.opportunity));
  store.analyses.markNotified(announced, makeAnalysis(store.get(announced)!.opportunity).analysisVersion, today);
  assert.equal(dailyAllowance(store, noon, 10).automaticToday, 4, 'the update does not use the automatic limit');

  // A selected alert that the owner then delivered by hand leaves the automatic count.
  const chosen = add(store, 'shortlist', today);
  store.alertQueue.record('batch-x', today, [{ key: chosen, status: 'selected', rank: 1, decision: 'shortlist' }]);
  store.markNotified(chosen, today);
  assert.equal(dailyAllowance(store, noon, 10).automaticToday, 5, 'a selected, confirmed one is automatic');
  store.alertQueue.markManual(chosen);
  const after = dailyAllowance(store, noon, 10);
  assert.equal(after.automaticToday, 4, 'delivered by hand: no longer automatic');
  assert.equal(after.manualDeliveries, 7);
});

test('previews are counted apart and never use the automatic limit', () => {
  const store = new OpportunityStore(':memory:');
  const today = '2026-09-21T15:00:00.000Z';
  const key = add(store, 'shortlist', today);
  for (let i = 0; i < 3; i += 1) {
    const delivery = store.deliveries.create('demo', key, `manual-preview#${i}`, 'demo', [{ label: 'Mensagem', content: 'x', silent: false }], today);
    store.deliveries.markPartSent(delivery.id, 1, `${i}`, today);
    store.deliveries.complete(delivery.id, today);
  }
  const allowance = dailyAllowance(store, new Date('2026-09-21T16:00:00.000Z'), 10);
  assert.equal(allowance.manualPreviews, 3);
  assert.equal(allowance.automaticToday, 0);
  assert.equal(allowance.remaining, 10);
  assert.equal(store.get(key)?.notifiedAt, null, 'a preview never marks the opportunity as delivered');
});

test('the count persists across restarts and separates automatic from manual', () => {
  const path = join(workDir, 'persist.db');
  const first = new OpportunityStore(path);
  autoSent(first, '2026-09-21T15:00:00.000Z');
  manualSent(first, '2026-09-21T15:10:00.000Z');
  first.close();
  const reopened = new OpportunityStore(path);
  const allowance = dailyAllowance(reopened, new Date('2026-09-21T16:00:00.000Z'), 10);
  assert.equal(allowance.automaticToday, 1);
  assert.equal(allowance.manualDeliveries, 1);
  reopened.close();
});

// ---------- selection and delivery ----------
const T0 = '2026-09-21T15:00:00.000Z';
const NOW = new Date('2026-09-21T15:05:00.000Z');
const RUN = '2026-09-21T15:00:00.000Z';
const sender = () => {
  const sent: string[] = [];
  const notifier: Notifier = { send: async (text) => (sent.push(/Project (\S+?)<\/b>/.exec(text)?.[1] ?? '?'), { messageId: `m${sent.length}` }) };
  return { notifier, sent };
};
const deliver = (store: OpportunityStore, notifier: Notifier, alertKeys: readonly OpportunityKey[], now: Date, perDay: number | undefined, maxAlerts = 5) =>
  notifyPending({ store, notifier, decisions: ALL, dryRun: false, format: { sourceLabels: SOURCE_LABELS, now }, now: () => now, maxAlerts, ...(perDay === undefined ? {} : { maxAlertsPerDay: perDay }), alertKeys });
const select = (store: OpportunityStore, batchId: string, now: Date, dailyCap: number, cap = 5) => selectAlertBatch(store, { batchId, decisions: ALL, cap, dailyCap, now });

test('the selection never exceeds what the day still allows, top matches first; what is owed keeps its place', () => {
  const store = new OpportunityStore(':memory:');
  for (let i = 0; i < 8; i += 1) autoSent(store, '2026-09-21T13:00:00.000Z'); // 8 of 10 automatic alerts already sent today
  const blue = [add(store, 'top_match', T0, 30), add(store, 'top_match', T0, 40), add(store, 'top_match', T0, 50)];
  const green = [add(store, 'shortlist', T0, 5), add(store, 'shortlist', T0, 6)];
  const batch = select(store, RUN, NOW, 10);
  assert.deepEqual(batch.daily, { cap: 10, day: '2026-09-21', automaticToday: 8, remaining: 2, manualDeliveries: 0, manualPreviews: 0 });
  assert.deepEqual(ids(batch.selected), ids(blue.slice(0, 2)), 'two slots left: blue keeps priority and does not exceed the day');
  assert.equal(batch.overflow, 3);
  assert.equal(store.alertQueue.get(green[0]!)?.status, 'overflow');

  // Two are still owed from before: they take the remaining places first.
  const later = new OpportunityStore(':memory:');
  for (let i = 0; i < 8; i += 1) autoSent(later, '2026-09-21T13:00:00.000Z');
  const owed = [add(later, 'review', T0, 10), add(later, 'review', T0, 11)];
  select(later, RUN, NOW, 10);
  add(later, 'top_match', '2026-09-21T15:30:00.000Z', 5);
  const next = select(later, '2026-09-21T15:30:00.000Z', new Date('2026-09-21T15:35:00.000Z'), 10);
  assert.deepEqual(ids(next.carriedOver), ids(owed), 'the retried ones are kept');
  assert.equal(next.selected.length, 0, 'no room left for a new blue today');
});

test('at the limit nothing more is sent today; the selected ones are not lost and go out the next day', async () => {
  const store = new OpportunityStore(':memory:');
  const keys = Array.from({ length: 5 }, (_, i) => add(store, 'shortlist', T0, 10 + i));
  const batch = select(store, RUN, NOW, 3, 5);
  assert.equal(batch.selected.length, 3, 'a daily cap of 3 selects three');

  // Today: only what the day allows is sent, in ranking order, and the rest stays selected and unmarked.
  const sink = sender();
  const today = await deliver(store, sink.notifier, batch.alertKeys, NOW, 3);
  assert.equal(today.sent, 3);
  assert.deepEqual(today.daily, { cap: 3, day: '2026-09-21', automaticToday: 0, remaining: 3, manualDeliveries: 0, manualPreviews: 0 });
  const again = await deliver(store, sink.notifier, [...batch.alertKeys, ...keys.slice(3)], new Date('2026-09-21T16:00:00.000Z'), 3);
  assert.equal(again.sent, 0, 'the day is full');
  assert.equal(again.heldByLimit, 2);
  assert.equal(again.daily?.remaining, 0);

  // The turn of the day: the two that were selected but held keep their place and are delivered.
  const held = new OpportunityStore(':memory:');
  const heldKeys = Array.from({ length: 4 }, (_, i) => add(held, 'shortlist', T0, 10 + i, '2026-09-21T15:00:00.000Z'));
  const heldBatch = select(held, RUN, NOW, 10, 4);
  assert.equal(heldBatch.selected.length, 4);
  const one = sender();
  const day1 = await deliver(held, one.notifier, heldBatch.alertKeys, NOW, 10, 2); // this run may only send 2
  assert.equal(day1.sent, 2);
  assert.equal(held.alertQueue.listSelectedPending(ALL).length, 2, 'two are still owed');
  const nextDay = new Date('2026-09-22T09:00:00.000Z');
  const nextBatch = select(held, '2026-09-22T09:00:00.000Z', nextDay, 10, 4);
  assert.deepEqual(ids(nextBatch.carriedOver), ids(held.alertQueue.listSelectedPending(ALL)), 'carried over, not lost');
  const day2 = await deliver(held, one.notifier, nextBatch.alertKeys, nextDay, 10, 4);
  assert.equal(day2.sent, 2);
  assert.equal(new Set(one.sent).size, 4, 'four different alerts in all: none repeated');
  assert.equal(heldKeys.length, 4);
});

test('the overflow and the backlog are never drained the next day, however much room the new day has', async () => {
  const store = new OpportunityStore(':memory:');
  add(store, 'shortlist', '2026-09-20T12:00:00.000Z'); // backlog from yesterday
  for (let i = 0; i < 12; i += 1) add(store, 'shortlist', T0, 10 + i);
  const day1 = select(store, RUN, NOW, 10);
  assert.equal(day1.selected.length, 5);
  assert.equal(day1.overflow, 7);
  const sink = sender();
  await deliver(store, sink.notifier, day1.alertKeys, NOW, 10);
  const nextDay = new Date('2026-09-22T09:00:00.000Z');
  const day2 = select(store, '2026-09-22T09:00:00.000Z', nextDay, 10);
  assert.equal(day2.alertKeys.length, 0, 'a fresh day with ten places still sends nothing old');
  assert.equal(day2.daily?.remaining, 10);
  const report = await deliver(store, sink.notifier, day2.alertKeys, nextDay, 10);
  assert.equal(report.sent, 0);
  assert.equal(sink.sent.length, 5);
});

test('a full automatic day does not stop a backlog send by hand, and it is not counted as automatic', async () => {
  const store = new OpportunityStore(':memory:');
  const backlog = Array.from({ length: 4 }, (_, i) => add(store, 'shortlist', '2026-09-20T12:00:00.000Z', 10 + i, T0));
  for (let i = 0; i < 10; i += 1) autoSent(store, '2026-09-21T13:00:00.000Z'); // the automatic day is full
  const sink = sender();
  // The manual paths (backlog, notify:manual) do not pass maxAlertsPerDay.
  const report = await notifyPending({ store, notifier: sink.notifier, decisions: ALL, dryRun: false, format: { sourceLabels: SOURCE_LABELS, now: NOW }, now: () => NOW, maxAlerts: 4, only: backlog, alertKeys: backlog });
  assert.equal(report.sent, 4);
  assert.equal(report.heldByLimit, 0);
  const allowance = dailyAllowance(store, NOW, 10);
  assert.equal(allowance.automaticToday, 10, 'the automatic use is unchanged');
  assert.equal(allowance.manualDeliveries, 4);
  assert.equal(allowance.remaining, 0);
});
