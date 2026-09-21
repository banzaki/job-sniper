import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ANALYSIS_VERSION } from '../ai/current-version.js';
import type { Opportunity } from '../domain/opportunity.js';
import { evaluateOpportunity } from '../filter/opportunity-filter.js';
import { donBrunoProfile } from '../profile/don-bruno.js';
import { toOpportunity } from '../sources/freelancer/freelancer-parser.js';
import { OpportunityStore } from '../storage/opportunity-store.js';
import { makeOpportunity } from '../testing/fixtures.js';
import { deliverDemo } from './deliver.js';
import { formatOpportunityMessage } from './format-message.js';
import { visibleLength } from './html.js';
import type { Notifier, SendOptions } from './notifier.js';
import { notifyPending } from './notify-pending.js';
import { describeClientBudget, formatMoney } from './present.js';
import { SOURCE_LABELS } from './source-labels.js';

const NOW = new Date('2026-09-21T12:00:00.000Z');
const HOUR = 3_600_000;
const epoch = (iso: string): number => Math.floor(Date.parse(iso) / 1000);
const OPTIONS = { sourceLabels: SOURCE_LABELS, now: NOW };

const raw = (over: Record<string, unknown> = {}) => ({
  id: 40725001,
  title: 'Responsive landing page in React',
  status: 'active',
  seo_url: 'website-design/Responsive-landing-page-React-40725001',
  type: 'fixed',
  jobs: [{ id: 1, name: 'React.js', category: { name: 'Websites, IT & Software' } }, { id: 2, name: 'HTML', category: { name: 'Websites, IT & Software' } }, { id: 3, name: 'CSS', category: { name: 'Design, Media & Architecture' } }],
  budget: { minimum: 250, maximum: 500 },
  currency: { code: 'USD', id: 1 },
  bid_stats: { bid_count: 14 },
  time_submitted: epoch('2026-09-20T15:00:00Z'),
  description: 'We need a responsive landing page built in React with clean HTML and CSS. Delivery within two weeks.',
  ...over,
});
const project = (over: Record<string, unknown> = {}, fetchedAt = NOW.toISOString()): Opportunity => toOpportunity(raw(over) as never, fetchedAt)!;
const judged = (opportunity: Opportunity) => evaluateOpportunity(opportunity, donBrunoProfile, NOW);
const message = (opportunity: Opportunity, preview = false) => formatOpportunityMessage(opportunity, judged(opportunity), { ...OPTIONS, ...(preview ? { kind: 'preview' as const } : {}) });

test('the project message follows the shared layout: source, recency, budget with its currency, competition, type, skills, summary and link', () => {
  const text = message(project());
  assert.ok(visibleLength(text) <= 1000, `${visibleLength(text)} characters`);
  const blocks = text.split('\n\n');
  assert.equal(blocks[0], '<b>🚨 NOVA OPORTUNIDADE</b>');
  assert.equal(blocks[1], '<b>🟢 OPORTUNIDADE COMPATÍVEL</b>');
  assert.equal(blocks[2], '<b>Responsive landing page in React</b>\n🌐 Freelancer.com · 🆕 Publicada há 1 dia');
  const facts = blocks[3]!.split('\n');
  assert.deepEqual(facts.slice(0, 3), ['💰 Orçamento: US$ 250–500', '👥 Concorrência: 14 propostas', '🧰 Tipo: preço fixo']);
  assert.ok(facts[3]!.startsWith('🧩 Habilidades: ') && facts[3]!.split(', ').length <= 4, 'at most four skills');
  assert.equal(facts.at(-1), '🎯 Compatibilidade: alta');
  assert.ok(blocks[4]!.startsWith('<b>📝 O projeto</b>\nWe need a responsive landing page built in React with clean HTML and CSS.'));
  assert.ok(blocks[5]!.startsWith('<b>🤖 Como a IA pode ajudar</b>\nAcelerar a estrutura inicial'));
  assert.equal(blocks.at(-1), '🔗 <a href="https://www.freelancer.com/projects/website-design/Responsive-landing-page-React-40725001">Abrir oportunidade</a>');
  assert.ok(!/preço sugerido|sugerid|rascunho|score|\/100|Esforço|⏱/i.test(text), 'the client budget is never a suggested price, and no effort or score is invented');
  assert.ok(!/PRÉVIA|não é um alerta novo/.test(text), 'a real opportunity never carries preview text');
  assert.ok(!/próximas mensagens/i.test(text));
});

test('every currency keeps its own code, amounts are never converted, and hourly projects say so', () => {
  assert.ok(message(project({ currency: { code: 'AUD', id: 3 }, budget: { minimum: 250, maximum: 750 } })).includes('💰 Orçamento: AUD 250–750'));
  assert.ok(message(project({ currency: { code: 'EUR', id: 8 }, budget: { minimum: 30, maximum: 250 } })).includes('💰 Orçamento: EUR 30–250'));
  assert.ok(message(project({ currency: { code: 'BRL', id: 9 }, budget: { minimum: 1500, maximum: 2500 } })).includes('💰 Orçamento: R$ 1.500–2.500'));
  const hourly = message(project({ type: 'hourly', currency: { code: 'USD', id: 1 }, budget: { minimum: 15, maximum: 25 } }));
  assert.ok(hourly.includes('💰 Orçamento: US$ 15–25\n'));
  assert.ok(hourly.includes('🧰 Tipo: por hora'));
  assert.ok(message(project({ type: 'hourly', budget: { minimum: 50, maximum: null } })).includes('a partir de US$ 50'));
  assert.ok(message(project({ budget: { minimum: null, maximum: null } })).includes('💰 Orçamento: não informado'));
  assert.ok(!/R\$/.test(message(project())), 'a USD budget never shows as reais');
});

test('money formatting is currency-aware in the shared budget description too, and 99Freelas reais are unchanged', () => {
  assert.equal(formatMoney('USD', 250, 500), 'US$ 250–500');
  assert.equal(formatMoney('usd', 250, 250), 'US$ 250');
  assert.equal(formatMoney('BRL', 1500.5, 2500), 'R$ 1.500,5–2.500');
  assert.equal(formatMoney('AUD', null, 40), 'até AUD 40');
  assert.equal(formatMoney('', 10, 20), '10–20');
  assert.equal(formatMoney('USD', null, null), 'não informado');
  assert.equal(describeClientBudget({ currency: 'BRL', kind: 'fixed', min: 1500, max: 2500 }), 'R$ 1.500–2.500');
  assert.equal(describeClientBudget({ currency: 'BRL', kind: 'hourly', min: 50, max: 80 }), 'R$ 50–80 por hora');
  assert.equal(describeClientBudget({ currency: 'USD', kind: 'hourly', min: 15, max: 25 }), 'US$ 15–25 por hora');
  assert.equal(describeClientBudget({ currency: 'BRL', kind: 'open', min: null, max: null }), 'em aberto (sem valor informado)');
});

test('recency: today, 1 day, up to 7 days, none beyond, and nothing invented for a missing date', () => {
  const at = (iso: string | null) => message(project({ time_submitted: iso ? epoch(iso) : undefined }));
  assert.ok(at('2026-09-21T08:00:00Z').includes('🆕 Publicada hoje'));
  assert.ok(at('2026-09-20T08:00:00Z').includes('🆕 Publicada há 1 dia'));
  assert.ok(at('2026-09-17T12:00:00Z').includes('🆕 Publicada há 4 dias'));
  assert.ok(at('2026-09-14T12:00:00Z').includes('🆕 Publicada há 7 dias'));
  assert.ok(!at('2026-09-13T11:00:00Z').includes('🆕'), 'over 7 days: no highlight');
  assert.ok(!at(null).includes('🆕'), 'unknown date: nothing that looks new');
});

test('the message stays under the ceiling with very long fields, and text from the API is escaped', () => {
  const long = project({ title: 'T'.repeat(400) + ' <b>x</b>', description: 'A very long sentence with no end '.repeat(60), jobs: Array.from({ length: 12 }, (_, i) => ({ id: i, name: `Skill number ${i} with a long name`, category: { name: 'Websites, IT & Software' } })) });
  for (const preview of [false, true]) {
    const text = message(long, preview);
    assert.ok(visibleLength(text) <= 1000, `${visibleLength(text)}`);
    assert.match(text, /Abrir oportunidade<\/a>$/);
    assert.equal((text.match(/<b>/g) ?? []).length, (text.match(/<\/b>/g) ?? []).length);
  }
  const escaped = message(project({ title: '<script>alert(1)</script> & "x"', description: 'Text <img src=x onerror=alert(1)> & more.' }));
  assert.ok(!escaped.includes('<script>') && !escaped.includes('<img'));
  assert.match(escaped, /&lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; &quot;x&quot;/);
});

// ---------- the filter for this source ----------
test('the filter keeps a defined technology project and stores, without alerting, what is not that', () => {
  assert.equal(judged(project()).decision, 'shortlist');
  assert.equal(judged(project({ title: 'Long-term web developer for our agency', description: 'React developer to join our team on an ongoing basis.' })).decision, 'skip', 'a continuing team role');
  assert.equal(judged(project({ jobs: [{ id: 9, name: 'Copywriting', category: { name: 'Writing & Content' } }], title: 'Landing page copy', description: 'Write copy for a landing page in HTML.' })).decision, 'review', 'a category that is not technology, but a specific skill is named in the title: a doubt, not a skip');
  assert.equal(judged(project({ title: 'Senior React developer', description: 'A React landing page.' })).decision, 'review', 'senior title');
  assert.equal(judged(project({ status: 'closed' })).decision, 'skip', 'a closed project');
  assert.equal(judged(project({ jobs: [{ id: 5, name: 'Logo Design', category: { name: 'Design, Media & Architecture' } }], title: 'Minimalist logo', description: 'Two-tone logo.' })).decision, 'skip', 'no skill of the profile');
  assert.ok(!judged(project()).reasons.some((reason) => /location/.test(reason)), 'a marketplace with no location is not asked about one');
});

test('a 99Freelas project is filtered and formatted exactly as before', () => {
  const p = makeOpportunity('7', { title: 'Landing page', budget: { currency: 'BRL', kind: 'fixed', min: 1500, max: 2500 } });
  const text = formatOpportunityMessage(p, judged(p), OPTIONS);
  assert.match(text, /💰 Orçamento: R\$ 1\.500–2\.500/);
  assert.match(text, /👥 Concorrência: 1 proposta/);
  assert.ok(!text.includes('Remuneração'), 'no job-layout facts');
});

// ---------- delivery: preview, once, and data freshness ----------
function recorder() {
  const sent: string[] = [];
  const notifier: Notifier = { send: async (text: string, _options: SendOptions = {}) => (sent.push(text), { messageId: `m${sent.length}` }) };
  return { notifier, sent };
}
const key = { sourceId: 'freelancer', externalId: '40725001' };
const seeded = (fetchedAt = NOW.toISOString()) => {
  const store = new OpportunityStore(':memory:');
  const opportunity = project({}, fetchedAt);
  store.insert(opportunity, judged(opportunity), NOW.toISOString());
  return store;
};

test('the preview is delivered once, identified, and leaves the real notification owed', async () => {
  const store = seeded();
  const { notifier, sent } = recorder();
  const demo = () => deliverDemo({ store, notifier, key, analysisVersion: ANALYSIS_VERSION, label: 'preview', dryRun: false, now: () => NOW, sourceLabels: SOURCE_LABELS });
  assert.equal((await demo()).partsSent, 1);
  assert.match(sent[0]!, /^<b>🧪 PRÉVIA DE FORMATO<\/b>\n\n/);
  assert.ok(!/NOVA OPORTUNIDADE|não é um alerta novo/.test(sent[0]!));
  assert.equal((await demo()).partsSent, 0, 'the repeat sends nothing');
  assert.equal(sent.length, 1);
  assert.equal(store.get(key)!.notifiedAt, null);
});

test('an alert is sent once from fresh data; data older than 24 hours is withheld, reported and never marked', async () => {
  const run = (store: OpportunityStore, notifier: Notifier) =>
    notifyPending({ store, notifier, decisions: ['shortlist', 'review'], dryRun: false, format: OPTIONS, maxAgeHoursBySource: { freelancer: 24 }, now: () => NOW });

  const fresh = seeded(new Date(NOW.getTime() - 3 * HOUR).toISOString());
  const one = recorder();
  const first = await run(fresh, one.notifier);
  assert.equal(first.sent, 1);
  assert.equal(first.staleWithheld, 0);
  assert.ok(fresh.get(key)!.notifiedAt);
  assert.equal((await run(fresh, one.notifier)).pending, 0);
  assert.equal(one.sent.length, 1, 'no resend');

  const stale = seeded(new Date(NOW.getTime() - 25 * HOUR).toISOString());
  const two = recorder();
  const held = await run(stale, two.notifier);
  assert.equal(held.staleWithheld, 1);
  assert.equal(held.sent, 0);
  assert.equal(two.sent.length, 0);
  assert.equal(stale.get(key)!.notifiedAt, null, 'not marked, so it is not counted as delivered');

  const other = new OpportunityStore(':memory:');
  const older = makeOpportunity('1', { fetchedAt: new Date(NOW.getTime() - 200 * HOUR).toISOString() });
  other.insert(older, judged(older), NOW.toISOString());
  const three = recorder();
  assert.equal((await run(other, three.notifier)).sent, 1, 'a source with no limit is not affected');
});
