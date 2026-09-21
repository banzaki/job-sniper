import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../config.js';
import type { FilterResult } from '../domain/filter-result.js';
import { evaluateOpportunity, FILTER_RULE_VERSION } from '../filter/opportunity-filter.js';
import { CLASSIFICATION } from '../notify/blocks.js';
import type { Notifier } from '../notify/notifier.js';
import { notifyPending } from '../notify/notify-pending.js';
import { SOURCE_LABELS } from '../notify/source-labels.js';
import { donBrunoProfile } from '../profile/don-bruno.js';
import { OpportunityStore } from '../storage/opportunity-store.js';
import { makeAnalysis, makeOpportunity, NOW } from '../testing/fixtures.js';
import { reevaluateOutdated } from './reevaluate.js';

const quiet = (): void => {};
const HOUR = 3_600_000;
const DESCRIPTION =
  'A responsive landing page for my bakery in React, HTML and CSS: hero, menu, opening hours, a contact form and a map. Mobile first, delivered in two weeks, and I will supply the texts and the photos.';

test('the ladder labels: blue, green and yellow, in this vocabulary', () => {
  assert.equal(CLASSIFICATION.top_match, '🔵 MATCH EXCELENTE');
  assert.equal(CLASSIFICATION.shortlist, '🟢 OPORTUNIDADE COMPATÍVEL');
  assert.equal(CLASSIFICATION.review, '🟡 VALE REVISAR');
});

test('configuration: whoever asked for shortlist also receives top_match; the default has all three; skip is never a default', () => {
  assert.deepEqual(loadConfig({}, quiet).notifyDecisions, ['top_match', 'shortlist', 'review']);
  assert.deepEqual(loadConfig({ TELEGRAM_NOTIFY_DECISIONS: 'shortlist' }, quiet).notifyDecisions, ['top_match', 'shortlist']);
  assert.deepEqual(loadConfig({ TELEGRAM_NOTIFY_DECISIONS: 'shortlist,review' }, quiet).notifyDecisions, ['top_match', 'shortlist', 'review']);
  assert.deepEqual(loadConfig({ TELEGRAM_NOTIFY_DECISIONS: ' Shortlist , REVIEW ' }, quiet).notifyDecisions, ['top_match', 'shortlist', 'review']);
  assert.deepEqual(loadConfig({ TELEGRAM_NOTIFY_DECISIONS: 'top_match,shortlist' }, quiet).notifyDecisions, ['top_match', 'shortlist'], 'no duplicate');
  assert.deepEqual(loadConfig({ TELEGRAM_NOTIFY_DECISIONS: 'top_match' }, quiet).notifyDecisions, ['top_match'], 'an explicit choice of only the best is respected');
  assert.deepEqual(loadConfig({ TELEGRAM_NOTIFY_DECISIONS: 'review' }, quiet).notifyDecisions, ['review'], 'nothing is added without shortlist');
});

function stored(id: string, decision: FilterResult['decision'], extra: string[] = []) {
  const opportunity = makeOpportunity(id, { sourceId: 'freelancer', title: `Project ${id}`, employmentType: 'freelance', proposalCount: 10, publishedAt: '2026-05-01T09:00:00.000Z' });
  const filter: FilterResult = { decision, reasons: ['strong signals: HTML', ...extra], matchedKeywords: ['HTML'], evaluatedAt: NOW.toISOString(), ruleVersion: FILTER_RULE_VERSION };
  return { opportunity, filter };
}

test('sending: a top match goes first and is marked like any other; the cap and the zero resend still hold', async () => {
  const store = new OpportunityStore(':memory:');
  for (const [id, decision] of [['r1', 'review'], ['s1', 'shortlist'], ['t1', 'top_match'], ['s2', 'shortlist'], ['t2', 'top_match']] as const) {
    const { opportunity, filter } = stored(id, decision);
    store.insert(opportunity, filter, '2026-05-01T00:00:00.000Z');
  }
  const sent: string[] = [];
  const notifier: Notifier = { send: async (text) => (sent.push(text), { messageId: `m${sent.length}` }) };
  const options = { store, notifier, decisions: loadConfig({ TELEGRAM_NOTIFY_DECISIONS: 'shortlist,review' }, quiet).notifyDecisions, dryRun: false, format: { sourceLabels: SOURCE_LABELS, now: NOW }, now: () => NOW, maxAlerts: 3 };

  const first = await notifyPending(options);
  assert.equal(first.sent, 3);
  const order = sent.map((text) => /Project (\S+?)<\/b>/.exec(text)?.[1]);
  assert.deepEqual(order, ['t1', 't2', 's1'], 'top matches first, then the shortlist');
  assert.ok(sent[0]!.includes('<b>🔵 MATCH EXCELENTE</b>'));
  assert.ok(sent[2]!.includes('<b>🟢 OPORTUNIDADE COMPATÍVEL</b>'));
  assert.equal(store.get({ sourceId: 'freelancer', externalId: 't1' })!.notifiedAt !== null, true);

  const second = await notifyPending(options);
  assert.equal(second.sent, 2);
  assert.deepEqual(sent.slice(3).map((text) => /Project (\S+?)<\/b>/.exec(text)?.[1]), ['s2', 'r1'], 'the rest, never a repeat');
});

test('the analysis selection treats a top match like a shortlist', () => {
  const store = new OpportunityStore(':memory:');
  const { opportunity, filter } = stored('t1', 'top_match');
  store.insert(opportunity, filter, '2026-05-01T00:00:00.000Z');
  const selection = store.analyses.select('v-test', { limit: 5 });
  assert.deepEqual(selection.keys, [{ sourceId: 'freelancer', externalId: 't1' }]);
  assert.equal(selection.totalEligible, 1);
});

// ---------- persistence: the rate is kept per source and currency; old rows keep everything ----------
test('re-evaluating stored rows to the new version changes only the filter columns and converts old rows from the recent cache', () => {
  const store = new OpportunityStore(':memory:');
  const build = (id: string, fetchedAt: string, rate?: number) =>
    makeOpportunity(id, {
      sourceId: 'freelancer',
      title: 'Responsive landing page in React',
      description: DESCRIPTION,
      category: 'Websites, IT & Software',
      subcategory: null,
      employmentType: 'freelance',
      proposalCount: 20,
      budget: { currency: 'INR', kind: 'fixed', min: 12_500, max: 37_500 },
      fetchedAt,
      sourceMetadata: { language: 'en', ...(rate === undefined ? {} : { exchangeRateToUsd: rate }) },
    });
  const oldFilter: FilterResult = { decision: 'shortlist', reasons: ['strong signals: HTML'], matchedKeywords: ['HTML'], evaluatedAt: '2026-09-01T00:00:00.000Z', ruleVersion: 'basic-v7' };
  const fresh = build('1', new Date(NOW.getTime() - 2 * HOUR).toISOString(), 0.0104); // carries a rate
  const old = build('2', new Date(NOW.getTime() - 50 * HOUR).toISOString()); // no rate, collected long ago
  const noRate = build('3', new Date(NOW.getTime() - 50 * HOUR).toISOString());
  for (const opportunity of [fresh, old, noRate]) store.insert(opportunity, oldFilter, '2026-09-01T00:00:00.000Z');
  store.markNotified({ sourceId: 'freelancer', externalId: '2' }, '2026-09-01T10:00:00.000Z');
  const analysis = makeAnalysis(old);
  store.analyses.save(analysis);
  const before = ['1', '2', '3'].map((id) => store.get({ sourceId: 'freelancer', externalId: id })!);

  // The cache holds the newest rate the source published for this currency (2 hours old: valid for 24).
  store.exchangeRates.record('freelancer', 'INR', 0.0104, new Date(NOW.getTime() - 2 * HOUR).toISOString());
  const report = reevaluateOutdated(store, donBrunoProfile, NOW);
  assert.equal(report.reevaluated, 3);
  assert.deepEqual(report.previousVersions, { 'basic-v7': 3 });

  const after = ['1', '2', '3'].map((id) => store.get({ sourceId: 'freelancer', externalId: id })!);
  assert.equal(after[0]!.filter.decision, 'top_match', 'own fresh rate');
  assert.equal(after[1]!.filter.decision, 'top_match', 'the old row is converted from the recent per-currency cache');
  assert.equal(after[2]!.filter.ruleVersion, FILTER_RULE_VERSION);
  // Only the filter columns changed: payload (the original budget included), first_seen, notified_at, analyses.
  for (const [i, entry] of after.entries()) {
    assert.deepEqual(entry.opportunity, before[i]!.opportunity, 'the original budget and every field are untouched');
    assert.equal(entry.firstSeenAt, before[i]!.firstSeenAt);
    assert.equal(entry.notifiedAt, before[i]!.notifiedAt);
  }
  assert.equal(after[1]!.notifiedAt, '2026-09-01T10:00:00.000Z');
  assert.notEqual(store.analyses.get({ sourceId: 'freelancer', externalId: '2' }, analysis.analysisVersion), null, 'the saved analysis is still there');

  // An expired cache stops only the top match; the opportunity stays.
  const expiredStore = new OpportunityStore(':memory:');
  expiredStore.insert(old, oldFilter, '2026-09-01T00:00:00.000Z');
  expiredStore.exchangeRates.record('freelancer', 'INR', 0.0104, new Date(NOW.getTime() - 25 * HOUR).toISOString());
  reevaluateOutdated(expiredStore, donBrunoProfile, NOW);
  assert.equal(expiredStore.get({ sourceId: 'freelancer', externalId: '2' })!.filter.decision, 'shortlist');
  // And the same rows evaluated directly agree with the stored decisions.
  assert.equal(evaluateOpportunity(old, donBrunoProfile, NOW, store.exchangeRates).decision, 'top_match');
  assert.equal(evaluateOpportunity(old, donBrunoProfile, NOW).decision, 'shortlist');
});
