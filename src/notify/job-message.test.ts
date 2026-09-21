import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Opportunity } from '../domain/opportunity.js';
import { evaluateOpportunity } from '../filter/opportunity-filter.js';
import { donBrunoProfile } from '../profile/don-bruno.js';
import { toOpportunity } from '../sources/remotive/remotive-parser.js';
import { ANALYSIS_VERSION } from '../ai/current-version.js';
import { OpportunityStore } from '../storage/opportunity-store.js';
import { makeOpportunity, NOW } from '../testing/fixtures.js';
import { deliverDemo } from './deliver.js';
import { formatOpportunityMessage, recencyLine } from './format-message.js';
import { visibleLength } from './html.js';
import type { Notifier, SendOptions } from './notifier.js';
import { notifyPending } from './notify-pending.js';
import { SOURCE_LABELS } from './source-labels.js';

const OPTIONS = { sourceLabels: SOURCE_LABELS };
const FETCHED = '2026-09-21T12:00:00.000Z';

const remotiveJob = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 4242,
  url: 'https://remotive.com/remote-jobs/software-dev/react-developer-4242',
  title: 'React Developer',
  company_name: 'Acme Studio',
  category: 'Software Development',
  tags: ['react', 'javascript'],
  job_type: 'freelance',
  publication_date: '2026-09-20T13:15:01',
  candidate_required_location: 'Worldwide',
  salary: '$50k - $70k',
  description: '<p>We are building a marketing site and need help with a responsive landing page. More details follow later.</p>',
  ...over,
});
const collected = (over: Record<string, unknown> = {}): Opportunity => toOpportunity(remotiveJob(over) as never, { feedFetchedAt: FETCHED })!;
const TODAY = new Date('2026-09-21T15:00:00.000Z');
const message = (opportunity: Opportunity, preview = false, now = TODAY) =>
  formatOpportunityMessage(opportunity, evaluateOpportunity(opportunity, donBrunoProfile, NOW), { ...OPTIONS, now, ...(preview ? { kind: 'preview' as const } : {}) });

test('the job message follows the shared layout: pay as published, type and required location, one summary, the link', () => {
  const text = message(collected());
  assert.ok(visibleLength(text) <= 1000, `${visibleLength(text)} characters`);
  const blocks = text.split('\n\n');
  assert.equal(blocks[0], '<b>🚨 NOVA OPORTUNIDADE</b>');
  assert.equal(blocks[1], '<b>🟢 OPORTUNIDADE COMPATÍVEL</b>');
  assert.equal(blocks[2], '<b>React Developer</b>\n🌐 Remotive · 🆕 Publicada há 1 dia');
  assert.ok(blocks[3]!.startsWith('💰 Remuneração (como publicada): $50k - $70k\n🧰 Tipo: Freelance\n📍 Localização exigida: Worldwide\n'));
  assert.ok(blocks[3]!.endsWith('🎯 Compatibilidade: alta'));
  assert.ok(blocks[4]!.startsWith('<b>📝 O projeto</b>\nWe are building a marketing site and need help with a responsive landing page.'));
  assert.ok(blocks.at(-1)!.startsWith('🔗 <a href="https://remotive.com/remote-jobs/software-dev/react-developer-4242">Abrir oportunidade</a>'));
  assert.ok(!/score|nota|preço sugerido|proposta|rascunho|orçamento|\/100|confiança|Esforço/i.test(text), 'no score, suggested price, effort, proposal or budget');
  assert.ok(!/próximas mensagens/i.test(text));
  assert.ok(!/atraso|24 ?h/i.test(text), 'the feed delay is documented, not repeated in every alert');
  assert.ok(!/PRÉVIA|não é um alerta novo/.test(text), 'a real opportunity never carries preview text');
});

test('the pay is shown exactly as published and never called a budget; a missing value says so', () => {
  assert.ok(message(collected({ salary: '€60,000/year' })).includes('💰 Remuneração (como publicada): €60,000/year'));
  assert.ok(message(collected({ salary: '' })).includes('💰 Remuneração (como publicada): não informada'));
  assert.ok(!/orçamento/i.test(message(collected({ salary: '$120k' }))), 'an annual salary is not a project budget');
});

test('type and location are shown as published, and a missing type is never shown as freelance', () => {
  assert.ok(message(collected()).includes('🧰 Tipo: Freelance'));
  assert.ok(message(collected({ job_type: 'contract' })).includes('🧰 Tipo: Contrato'), 'a stored contract is still labeled as a contract');
  const unknown = message(collected({ job_type: '' }));
  assert.ok(unknown.includes('🧰 Tipo: não informado'));
  assert.ok(!unknown.includes('Freelance'));
  assert.ok(message(collected({ job_type: 'temporary' })).includes('🧰 Tipo: temporary'));
  assert.ok(message(collected({ candidate_required_location: '' })).includes('📍 Localização exigida: não informada'));
});

test('Atenção holds the main caveat only, translated: location, then type, then seniority', () => {
  const remote = message(collected({ candidate_required_location: 'Remote' }));
  assert.ok(remote.includes('<b>🟡 VALE REVISAR</b>'));
  assert.ok(remote.includes('<b>⚠️ Atenção</b>\nLocalização &quot;Remote&quot; é ambígua para quem mora no Brasil.'));
  assert.ok(message(collected({ job_type: '' })).includes('<b>⚠️ Atenção</b>\nTipo de contratação não informado.'));
  assert.ok(message(collected({ title: 'Senior React Developer' })).includes('<b>⚠️ Atenção</b>\nSenioridade no título: senior.'));
  assert.ok(!message(collected()).includes('Atenção'), 'no caveat, no block');
  assert.equal((remote.match(/Atenção/g) ?? []).length, 1);
});

test('a very long title, company, location, pay and description still fit the ceiling, with the link intact', () => {
  const long = collected({
    title: 'T'.repeat(400),
    company_name: 'C'.repeat(200),
    candidate_required_location: 'Worldwide, ' + 'somewhere far away, '.repeat(30),
    salary: '$1 - $2 per something, '.repeat(30),
    description: '<p>' + 'A very long sentence without an end '.repeat(80) + '</p>',
  });
  for (const preview of [false, true]) {
    const text = message(long, preview);
    assert.ok(visibleLength(text) <= 1000, `${visibleLength(text)} characters`);
    assert.match(text, /Abrir oportunidade<\/a>$/);
    assert.equal((text.match(/<b>/g) ?? []).length, (text.match(/<\/b>/g) ?? []).length, 'no tag was cut');
  }
});

test('external text is escaped, and only a safe link is linked', () => {
  const text = message(collected({ title: '<b>Dev</b> & "co"', company_name: '<i>Acme</i>' }));
  assert.ok(text.includes('&lt;b&gt;Dev&lt;/b&gt; &amp; &quot;co&quot;'));
  const unsafe: Opportunity = { ...collected(), url: 'javascript:alert(1)' };
  assert.ok(!message(unsafe).includes('href='));
});

test('the preview is identified, and the project layout of the other source is unchanged in kind', () => {
  assert.ok(message(collected(), true).startsWith('<b>🧪 PRÉVIA DE FORMATO</b>\n\n<b>🟢 OPORTUNIDADE COMPATÍVEL</b>'));
  assert.ok(!message(collected()).includes('PRÉVIA'));

  const project = makeOpportunity('7', { title: 'Landing page' });
  const text = formatOpportunityMessage(project, { decision: 'review', reasons: ['strong signals: HTML'], matchedKeywords: ['HTML'], evaluatedAt: 'e', ruleVersion: 'basic-v5' }, OPTIONS);
  assert.match(text, /💰 Orçamento: em aberto \(sem valor informado\)/);
  assert.match(text, /👥 Concorrência: 1 proposta/);
  assert.ok(!text.includes('Remuneração'));
});

// ---------- delivery ----------
function recorder() {
  const sent: { text: string; silent: boolean }[] = [];
  const notifier: Notifier = {
    send: async (text: string, options: SendOptions = {}) => {
      sent.push({ text, silent: options.silent === true });
      return { messageId: `m${sent.length}` };
    },
  };
  return { notifier, sent };
}

function seededRemotive(store: OpportunityStore): void {
  const opportunity = collected();
  store.insert(opportunity, evaluateOpportunity(opportunity, donBrunoProfile, NOW), '2026-09-21T12:00:00.000Z');
}
const key = { sourceId: 'remotive', externalId: '4242' };
const demo = (store: OpportunityStore, notifier: Notifier, dryRun = false) =>
  deliverDemo({ store, notifier, key, analysisVersion: ANALYSIS_VERSION, label: 'preview', dryRun, now: () => NOW, ...OPTIONS });

test('a preview of an opportunity without analysis uses the basic message, is delivered once, and touches no production flag', async () => {
  const store = new OpportunityStore(':memory:');
  seededRemotive(store);
  const { notifier, sent } = recorder();

  const dry = await demo(store, notifier, true);
  assert.equal(dry.rendered, 1);
  assert.deepEqual(store.deliveries.counts(), { complete: 0, incomplete: 0, partsPending: 0 }, 'dry-run stores nothing');

  const first = await demo(store, notifier);
  assert.equal(first.partsSent, 1);
  assert.equal(first.complete, true);
  assert.ok(sent[1]!.text.startsWith('<b>🧪 PRÉVIA DE FORMATO</b>'));
  assert.ok(!/score|preço sugerido|esforço|rascunho/i.test(sent[1]!.text));

  const second = await demo(store, notifier);
  assert.equal(second.partsSent, 0, 'the repeat sends nothing');
  assert.equal(second.partsAlreadyConfirmed, 1);
  assert.equal(sent.length, 2);
  assert.equal(store.get(key)!.notifiedAt, null, 'the real notification is still owed');
});

test('a demo needs a stored opportunity, and never an AI analysis', async () => {
  const store = new OpportunityStore(':memory:');
  await assert.rejects(demo(store, recorder().notifier), /No stored opportunity remotive:4242/);
});

test('the regular notification sends the compact job message once and marks it', async () => {
  const store = new OpportunityStore(':memory:');
  seededRemotive(store);
  const { notifier, sent } = recorder();
  const run = () => notifyPending({ store, notifier, decisions: ['shortlist', 'review'], dryRun: false, analysisVersion: ANALYSIS_VERSION, format: OPTIONS, now: () => NOW });

  const first = await run();
  assert.equal(first.sent, 1);
  assert.equal(sent.length, 1);
  assert.ok(sent[0]!.text.includes('🌐 Remotive'));
  assert.ok(sent[0]!.text.startsWith('<b>🚨 NOVA OPORTUNIDADE</b>'));
  assert.ok(!/PRÉVIA|não é um alerta novo/.test(sent[0]!.text), 'a real alert is never marked as a preview');
  assert.ok(store.get(key)!.notifiedAt);
  assert.equal((await run()).pending, 0);
  assert.equal(sent.length, 1, 'no resend');
});

// ---------- recency ----------
const withDate = (publication_date: unknown) => collected({ publication_date });

test('a reliable date up to 7 days old is highlighted with its age; the calendar day is all a zone-less date gives', () => {
  const at = (date: string) => recencyLine(withDate(date), TODAY);
  assert.equal(at('2026-09-21T03:00:00'), '🆕 Publicada hoje');
  assert.equal(at('2026-09-20T13:15:01'), '🆕 Publicada há 1 dia');
  assert.equal(at('2026-09-18T16:43:22'), '🆕 Publicada há 3 dias');
  assert.equal(at('2026-09-14T00:00:00'), '🆕 Publicada há 7 dias', 'seven days is still recent');
  assert.equal(at('2026-09-14'), '🆕 Publicada há 7 dias', 'a date without a time works too');
  assert.ok(!/\d{2}:\d{2}|\d{1,2}h\d{2}/.test(at('2026-09-18T16:43:22') ?? ''), 'no time of day is shown or invented');
});

test('older, future, missing or unusable dates get no highlight', () => {
  const at = (date: unknown) => recencyLine(withDate(date), TODAY);
  assert.equal(at('2026-09-13T10:00:00'), null, 'eight days');
  assert.equal(at('2026-01-01T10:00:00'), null);
  assert.equal(at('2026-09-25T10:00:00'), null, 'a date in the future');
  for (const bad of [undefined, null, '', 'yesterday', 'not a date']) assert.equal(at(bad), null, String(bad));
  assert.ok(!message(withDate('2026-01-01T10:00:00')).includes('🆕'));
  assert.ok(!message(withDate(undefined)).includes('🆕'), 'unknown date: nothing that looks new');
});

test('a date with an explicit time zone is measured in calendar days of Brasília time', () => {
  const opportunity: Opportunity = { ...collected(), publishedAt: '2026-09-19T12:00:00.000Z' };
  assert.equal(recencyLine(opportunity, TODAY), '🆕 Publicada há 2 dias');
  assert.equal(recencyLine({ ...opportunity, publishedAt: '2026-09-21T14:59:00.000Z' }, TODAY), '🆕 Publicada hoje');
});

test('a row stored before publishedDay existed is still read from its raw, zone-less date', () => {
  const stored = collected();
  const { publishedDay: _omitted, ...metadata } = stored.sourceMetadata;
  assert.equal(recencyLine({ ...stored, sourceMetadata: metadata }, TODAY), '🆕 Publicada há 1 dia');
});

test('the recency line is shown in the alert and in the preview', () => {
  assert.ok(message(withDate('2026-09-18T16:43:22')).includes('🌐 Remotive · 🆕 Publicada há 3 dias'));
  assert.ok(message(withDate('2026-09-18T16:43:22'), true).includes('🆕 Publicada há 3 dias'));
  assert.ok(visibleLength(message(withDate('2026-09-18T16:43:22'), true)) <= 1000);
});
