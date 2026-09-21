import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Opportunity } from '../domain/opportunity.js';
import { evaluateOpportunity } from '../filter/opportunity-filter.js';
import { donBrunoProfile } from '../profile/don-bruno.js';
import type { ExchangeRateLookup, ObservedRate } from '../storage/exchange-rate-store.js';
import { makeOpportunity } from '../testing/fixtures.js';
import { displayBudget } from './budget-display.js';
import { formatOpportunityMessage } from './format-message.js';

const NOW = new Date('2026-09-21T12:00:00.000Z');
const HOUR = 3_600_000;
const iso = (hoursAgo: number): string => new Date(NOW.getTime() - hoursAgo * HOUR).toISOString();

const project = (over: Partial<Opportunity> = {}, rate?: number, fetchedAt = NOW.toISOString()): Opportunity =>
  makeOpportunity('1', {
    sourceId: 'freelancer',
    title: 'HTML and CSS landing page',
    description: 'A landing page in HTML and CSS for my small business, with a hero, services, contact form and a map. Design is ready and I will send the texts and the photos for it.',
    category: 'Websites, IT & Software',
    subcategory: null,
    employmentType: 'freelance',
    proposalCount: 30,
    fetchedAt,
    sourceMetadata: { language: 'en', ...(rate === undefined ? {} : { exchangeRateToUsd: rate }) },
    ...over,
  });
const ratesOf = (entries: Record<string, ObservedRate>): ExchangeRateLookup => ({ lookup: (source, currency) => entries[`${source}:${currency}`] ?? null });
const inr = (min: number, max: number, kind: 'fixed' | 'hourly' = 'fixed') => ({ currency: 'INR', kind, min, max });
const show = (opportunity: Opportunity, over: { displayCurrency?: string; rates?: ExchangeRateLookup } = {}) => displayBudget(opportunity, { now: NOW, ...over });

test('a fresh rate shows the converted value first with "≈" and the original below, keeping fixed or hourly', () => {
  assert.deepEqual(show(project({ budget: inr(600, 1500) }, 0.010439)), { value: '≈ US$ 6–16', original: 'INR 600–1.500' });
  assert.deepEqual(show(project({ budget: inr(750, 1250, 'hourly') }, 0.010439)), { value: '≈ US$ 8–13/h', original: 'INR 750–1.250/h' });
  assert.deepEqual(show(project({ budget: { currency: 'EUR', kind: 'fixed', min: 100, max: null } }, 1.15)), { value: '≈ a partir de US$ 115', original: 'a partir de EUR 100' });
  // Tiny amounts keep one decimal rather than showing zero.
  assert.equal(show(project({ budget: inr(40, 45) }, 0.0104)).value, '≈ US$ 0,4–0,5');
});

test('a budget already in the display currency is one line only; USD hourly keeps its "/h"', () => {
  assert.deepEqual(show(project({ budget: { currency: 'USD', kind: 'hourly', min: 10, max: 20 } })), { value: 'US$ 10–20/h', original: null });
  assert.deepEqual(show(project({ budget: { currency: 'USD', kind: 'fixed', min: 250, max: 500 } })), { value: 'US$ 250–500', original: null });
  assert.deepEqual(show(project({ budget: { currency: 'inr', kind: 'fixed', min: 600, max: 1500 } }), { displayCurrency: 'INR' }), { value: 'INR 600–1.500', original: null }, 'case does not matter');
});

test('without a fresh rate only the original is shown: absent, expired, or of another source or currency; nothing is estimated', () => {
  assert.deepEqual(show(project({ budget: inr(600, 1500) })), { value: 'INR 600–1.500', original: null }, 'no rate at all');
  assert.deepEqual(show(project({ budget: inr(600, 1500) }, 0.0104, iso(30))), { value: 'INR 600–1.500', original: null }, 'the rate the row carries is 30 hours old');
  const fresh: ObservedRate = { rateToUsd: 0.0104, observedAt: iso(3) };
  assert.equal(show(project({ budget: inr(600, 1500) }), { rates: ratesOf({ 'freelancer:INR': fresh }) }).value, '≈ US$ 6–16', 'the stored rate of the same source and currency serves an old row');
  assert.equal(show(project({ budget: inr(600, 1500) }), { rates: ratesOf({ 'freelancer:INR': { ...fresh, observedAt: iso(25) } }) }).value, 'INR 600–1.500', 'expired');
  assert.equal(show(project({ budget: inr(600, 1500) }), { rates: ratesOf({ 'remotive:INR': fresh }) }).value, 'INR 600–1.500', 'another source');
  assert.equal(show(project({ budget: inr(600, 1500) }), { rates: ratesOf({ 'freelancer:EUR': fresh }) }).value, 'INR 600–1.500', 'another currency');
  for (const bad of [0, -1, Number.NaN]) assert.equal(show(project({ budget: inr(600, 1500) }, bad)).value, 'INR 600–1.500', `rate ${bad}`);
});

test('another display currency converts through the stored rates of the same source, and needs both of them fresh', () => {
  const rates = ratesOf({ 'freelancer:INR': { rateToUsd: 0.01, observedAt: iso(2) }, 'freelancer:BRL': { rateToUsd: 0.2, observedAt: iso(2) } });
  assert.deepEqual(show(project({ budget: inr(1000, 2000) }), { displayCurrency: 'BRL', rates }), { value: '≈ R$ 50–100', original: 'INR 1.000–2.000' });
  assert.deepEqual(show(project({ budget: { currency: 'USD', kind: 'fixed', min: 100, max: 200 } }), { displayCurrency: 'brl', rates }), { value: '≈ R$ 500–1.000', original: 'US$ 100–200' });
  const noBrl = ratesOf({ 'freelancer:INR': { rateToUsd: 0.01, observedAt: iso(2) } });
  assert.deepEqual(show(project({ budget: inr(1000, 2000) }), { displayCurrency: 'BRL', rates: noBrl }), { value: 'INR 1.000–2.000', original: null }, 'no BRL rate: only the original');
});

test('an open, unknown or missing budget is shown as before', () => {
  assert.equal(show(project({ budget: { currency: 'BRL', kind: 'open', min: null, max: null } })).value, 'em aberto (sem valor informado)');
  assert.equal(show(project({ budget: null })).value, 'não informado');
  assert.equal(show(project({ budget: { currency: 'INR', kind: 'unknown', min: 1, max: 2 } })).value, 'não informado');
});

test('the message shows the two lines, and the caveat block never repeats the conversion', () => {
  const opportunity = project({ budget: inr(750, 1250, 'hourly'), proposalCount: 20 }, 0.010439);
  const filter = evaluateOpportunity(opportunity, donBrunoProfile, NOW);
  assert.equal(filter.decision, 'shortlist');
  const text = formatOpportunityMessage(opportunity, filter, { now: NOW });
  assert.ok(text.includes('💰 Orçamento: ≈ US$ 8–13/h\n↳ Original: INR 750–1.250/h\n'), 'converted first, original below');
  assert.ok(text.includes('🧰 Tipo: por hora'), 'hourly is preserved');
  const attention = text.split('⚠️ Atenção</b>\n')[1]!;
  assert.match(attention, /^Faixa de orçamento atravessa o piso de US\$ 8\/h\./);
  assert.ok(!/7,8|≈|13/.test(attention.split('\n\n')[0]!), 'the converted range is not repeated in the caveat');

  // A low budget keeps its own sentence, with no numbers at all.
  const cheap = project({ budget: inr(600, 1500), proposalCount: 20 }, 0.010439);
  const cheapText = formatOpportunityMessage(cheap, evaluateOpportunity(cheap, donBrunoProfile, NOW), { now: NOW });
  assert.ok(cheapText.includes('💰 Orçamento: ≈ US$ 6–16\n↳ Original: INR 600–1.500\n'));
  assert.ok(cheapText.includes('Orçamento baixo para o escopo; avalie se compensa pelo portfólio, avaliação ou experiência.'));

  // USD: a single line; and without a fresh rate only the original.
  const usd = project({ budget: { currency: 'USD', kind: 'hourly', min: 10, max: 20 } });
  assert.ok(formatOpportunityMessage(usd, evaluateOpportunity(usd, donBrunoProfile, NOW), { now: NOW }).includes('💰 Orçamento: US$ 10–20/h\n👥'));
  const stale = project({ budget: inr(600, 1500) }, 0.0104, iso(40));
  const staleText = formatOpportunityMessage(stale, evaluateOpportunity(stale, donBrunoProfile, NOW), { now: NOW });
  assert.ok(staleText.includes('💰 Orçamento: INR 600–1.500\n👥') && !staleText.includes('≈') && !staleText.includes('Original'));
});

test('the display rates come from the stored cache: the delivery hands them to the message', () => {
  const opportunity = project({ budget: inr(600, 1500) });
  const filter = evaluateOpportunity(opportunity, donBrunoProfile, NOW);
  const rates = ratesOf({ 'freelancer:INR': { rateToUsd: 0.0104, observedAt: iso(1) } });
  assert.ok(formatOpportunityMessage(opportunity, filter, { now: NOW, rates }).includes('≈ US$ 6–16'));
  assert.ok(formatOpportunityMessage(opportunity, filter, { now: NOW, rates, displayCurrency: 'INR' }).includes('💰 Orçamento: INR 600–1.500\n'));
});
