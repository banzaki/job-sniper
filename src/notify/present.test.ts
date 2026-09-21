import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MatchAnalysis } from '../domain/match-analysis.js';
import type { Opportunity } from '../domain/opportunity.js';
import { brunoCandidate } from '../profile/bruno-candidate.js';
import { makeAnalysis, makeFilter, makeOpportunity, NOW } from '../testing/fixtures.js';
import { formatOpportunityMessage } from './format-message.js';
import { visibleLength } from './html.js';
import { COMPACT_CEILING, describeClientBudget, formatBrasiliaTime, formatBrl, formatHours, renderAnalysisMessage } from './present.js';
import { translateReason } from './translate-reasons.js';

const render = (opportunity: Opportunity, analysis: MatchAnalysis, mode: 'enriched' | 'update' | 'demo' = 'enriched', candidate = brunoCandidate) =>
  renderAnalysisMessage({ opportunity, analysis, candidate, mode, now: NOW, sourceLabels: { fake: '99Freelas' } });

/** Every opened tag must be closed, in order; a cut tag would break Telegram's parser. */
function assertBalancedTags(html: string): void {
  const stack: string[] = [];
  for (const match of html.matchAll(/<\/?([a-z]+)(?:\s[^>]*)?>/gi)) {
    const name = match[1]!.toLowerCase();
    if (match[0].startsWith('</')) assert.equal(stack.pop(), name, `unbalanced </${name}>`);
    else stack.push(name);
  }
  assert.deepEqual(stack, [], 'every tag is closed');
}

const restricted = (id: string, over: Partial<Opportunity> = {}) =>
  makeOpportunity(id, {
    title: 'Landing Page para o PREDPACK',
    summary: '1. Objetivo Vender o PREDPACK, uma biblioteca de cenas de filmes e séries já cortadas para editores. Precisamos de uma página leve.',
    access: { kind: 'premium_only', publicAt: '2026-05-02T19:37:00.000Z', rawLabel: 'Projeto Exclusivo' },
    ...over,
  });

test('one compact message, in the agreed order, from persisted values only', () => {
  const opportunity = restricted('7');
  const analysis = makeAnalysis(opportunity, { recommendation: 'review', score: 55, confidence: 'low', effort: { minHours: 12, maxHours: 25 }, price: { minBrl: 600, maxBrl: 1250, rationale: 'Base' }, complexity: 'medium' }, NOW, brunoCandidate);
  const message = render(opportunity, analysis);

  const expectedOrder = [
    '<b>🟡 VALE REVISAR</b>',
    '<b>Landing Page para o PREDPACK</b>',
    'Plataforma: 99Freelas',
    'Vender o PREDPACK, uma biblioteca de cenas de filmes e séries já cortadas para editores.',
    'Preço sugerido pela IA: R$ 600–1.250',
    'Orçamento do cliente: em aberto (sem valor informado)',
    'Esforço estimado: 12–25 horas',
    '⚠️ Competências essenciais ainda não verificadas: HTML, CSS, landing pages',
    'Disponibilidade: restrita na última consulta (01/05 às 09h00). Liberação estimada: 02/05 às 16h37 (Brasília); confirmar no site.',
    '🔗 <a href="https://example.test/project/7">Abrir projeto</a>',
  ];
  let position = -1;
  for (const fragment of expectedOrder) {
    const at = message.text.indexOf(fragment);
    assert.ok(at > position, `missing or out of order: ${fragment}`);
    position = at;
  }
  assert.equal(message.silent, false);
  const length = visibleLength(message.text);
  assert.ok(length >= 400 && length <= 900, `expected roughly 600-900 characters, got ${length}`);
});

test('the message leaves out the proposal, skill lists, internal explanations and any "next messages" promise', () => {
  const opportunity = restricted('8');
  const text = render(opportunity, makeAnalysis(opportunity, {}, NOW, brunoCandidate)).text;
  assert.ok(!/Olá! Li o briefing|Rascunho|Proposta|✍️/.test(text), 'no proposal');
  assert.ok(!/Requisitos essenciais|Verificadas:|Lacunas|Perguntas ao cliente|Por que essa nota|Compatibilidade|\/100|confiança/.test(text), 'no skill lists, score or internal explanations');
  assert.ok(!/próximas mensagens|Detalhes \d|detalhes/i.test(text), 'no promise of a second message');
  assert.ok(!/capped at|Essential skills not fully verified|basic-v2|ai-v\d|\+p[0-9a-f]{8}/.test(text), 'no internal names or English notes');
  assert.ok(!/Ausentes no perfil: .*Verificadas/.test(text));
  assert.equal(text.split('Plataforma:').length - 1, 1);
});

test('nothing in the example is hard-coded: other persisted values render as they are', () => {
  const opportunity = makeOpportunity('9', { title: 'Site institucional', budget: { currency: 'BRL', kind: 'fixed', min: 1500, max: 2500 }, summary: 'Um site simples para uma clínica. Com três páginas.' });
  const analysis = makeAnalysis(opportunity, { price: { minBrl: 2000, maxBrl: 2000, rationale: 'x' }, effort: { minHours: 1, maxHours: 1 }, complexity: 'high', score: 91, confidence: 'medium' });
  const text = render(opportunity, analysis).text;
  assert.match(text, /Preço sugerido pela IA: R\$ 2\.000\n/);
  assert.match(text, /Orçamento do cliente: R\$ 1\.500–2\.500\n/);
  assert.match(text, /Esforço estimado: 1 hora\n/);
  assert.match(text, /\nUm site simples para uma clínica\.\n/, 'only the first sentence of the description');
  assert.ok(!text.includes('Com três páginas'));
  assert.ok(!/PREDPACK|600|1\.250|21\/09/.test(text), 'no value from another example leaks in');
});

test('the client budget is kept apart from the AI price, and a missing value is "não informado"', () => {
  assert.equal(describeClientBudget(null), 'não informado');
  assert.equal(describeClientBudget({ currency: 'BRL', kind: 'unknown', min: null, max: null }), 'não informado');
  assert.equal(describeClientBudget({ currency: 'BRL', kind: 'open', min: null, max: null }), 'em aberto (sem valor informado)');
  assert.equal(describeClientBudget({ currency: 'BRL', kind: 'hourly', min: 50, max: 80 }), 'R$ 50–80 por hora');
  assert.equal(formatBrl(600, 1250), 'R$ 600–1.250');
  assert.equal(formatHours(12, 25), '12–25 horas');
});

test('Brasília time is formatted from the real instant, and invalid dates yield nothing', () => {
  assert.equal(formatBrasiliaTime('2026-09-21T19:37:02.087Z'), '21/09 às 16h37');
  assert.equal(formatBrasiliaTime('2026-01-15T02:05:00.000Z'), '14/01 às 23h05');
  assert.equal(formatBrasiliaTime('not a date'), null);
});

test('the main caveat: unverified essential skills first, then the AI risk; a known alias stays unverified, not absent', () => {
  const opportunity = makeOpportunity('10');
  const fresh = makeAnalysis(opportunity, { essentialSkills: ['HTML', 'design responsivo', 'Photoshop'], matchedSkills: ['HTML'], missingSkills: [] }, NOW, brunoCandidate);
  assert.match(render(opportunity, fresh).text, /⚠️ Competências essenciais ainda não verificadas: HTML, design responsivo\./);

  // Stored before the alias was known: listed as "not covered"; the display regroups it.
  const legacy: MatchAnalysis = { ...fresh, verification: { ...fresh.verification, unverified: ['HTML'], notCovered: ['design responsivo', 'Photoshop'] } };
  const text = render(opportunity, legacy).text;
  assert.match(text, /não verificadas: HTML, design responsivo\./);
  assert.ok(!/Ausentes/.test(text), 'a known alias is not "absent"');

  const onlyAbsent: MatchAnalysis = { ...fresh, verification: { ...fresh.verification, unverified: [], learning: [], notCovered: ['Photoshop'] } };
  assert.match(render(opportunity, onlyAbsent).text, /⚠️ Ausentes no perfil: Photoshop\./);

  const verified = makeAnalysis(opportunity);
  assert.match(render(opportunity, verified).text, /⚠️ Escopo pouco detalhado/);
  const noRisk: MatchAnalysis = { ...verified, risks: [] };
  assert.ok(!render(opportunity, noRisk).text.includes('⚠️'), 'no caveat line when there is nothing relevant');
});

test('availability is never stated as confirmed', () => {
  const now = NOW;
  const past = render(restricted('11', { access: { kind: 'premium_only', publicAt: '2026-04-30T12:00:00.000Z', rawLabel: 'x' } }), makeAnalysis(restricted('11')));
  assert.match(past.text, /a liberação estimada \(.*\) já passou\. Confirmar no site\./);
  const unknownTime = render(restricted('12', { access: { kind: 'premium_only', publicAt: null, rawLabel: 'x' } }), makeAnalysis(restricted('12')));
  assert.match(unknownTime.text, /horário de liberação desconhecido\. Confirmar no site\./);
  const open = render(makeOpportunity('13'), makeAnalysis(makeOpportunity('13')));
  assert.match(open.text, /Disponibilidade: aberta na última consulta \(.*\)\. Confirmar no site\./);
  const unknown = render(makeOpportunity('14', { access: { kind: 'unknown', publicAt: null, rawLabel: null } }), makeAnalysis(makeOpportunity('14')));
  assert.match(unknown.text, /Disponibilidade: não verificada\. Confirmar no site\./);
  for (const entry of [past, unknownTime, open, unknown]) assert.ok(!/liberada|pode se candidatar|já está aberta/i.test(entry.text));
  assert.ok(now instanceof Date);
});

test('very long fields are tightened, never cut mid-tag, and never exceed the ceiling', () => {
  const opportunity = makeOpportunity('15', { title: 'T'.repeat(300), summary: 'Descrição sem fim '.repeat(200) + '.' });
  const analysis = makeAnalysis(opportunity, {}, NOW, brunoCandidate);
  const long: MatchAnalysis = {
    ...analysis,
    verification: { ...analysis.verification, unverified: Array.from({ length: 12 }, (_, i) => `Habilidade ${i} ${'h'.repeat(30)}`) },
  };
  for (const mode of ['enriched', 'update', 'demo'] as const) {
    const message = render(opportunity, long, mode);
    assert.ok(visibleLength(message.text) <= COMPACT_CEILING, `${mode}: ${visibleLength(message.text)} characters`);
    assertBalancedTags(message.text);
    assert.match(message.text, /Abrir projeto<\/a>/, 'the link survives the tightening');
  }
});

test('external text is escaped everywhere, and only http(s) links are linked', () => {
  const opportunity = makeOpportunity('16', { title: '<script>alert(1)</script> & "x"', summary: 'Texto <b>com</b> tags & aspas.', url: 'https://example.test/?a=1&b="2"' });
  const text = render(opportunity, makeAnalysis(opportunity)).text;
  assert.ok(!text.includes('<script>') && !text.includes('<b>com</b>'));
  assert.match(text, /&lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; &quot;x&quot;/);
  assert.match(text, /Texto &lt;b&gt;com&lt;\/b&gt; tags &amp; aspas\./);
  assert.match(text, /href="https:\/\/example\.test\/\?a=1&amp;b=%22 ?2%22"|href="https:\/\/example\.test\/\?a=1&amp;b=%222%22"/);
  assertBalancedTags(text);
  const unsafe = render(makeOpportunity('17', { url: 'javascript:alert(1)' }), makeAnalysis(makeOpportunity('17')));
  assert.ok(!unsafe.text.includes('href='));
  assert.ok(!/🔗/.test(unsafe.text));
});

test('emoji and accents in the title survive, and there are only a few emojis', () => {
  const opportunity = makeOpportunity('18', { title: 'Site bonito 🚀 com ação' });
  const text = render(opportunity, makeAnalysis(opportunity, {}, NOW, brunoCandidate)).text;
  assert.ok(text.includes('Site bonito 🚀 com ação'));
  const emojis = text.match(/\p{Extended_Pictographic}/gu) ?? [];
  assert.ok(emojis.length <= 5, `${emojis.length} emojis`);
});

test('an update is labeled briefly, and the demo is clearly a preview', () => {
  const opportunity = makeOpportunity('19');
  const analysis = makeAnalysis(opportunity);
  assert.match(render(opportunity, analysis, 'update').text, /VALE CANDIDATAR-SE<\/b> · análise atualizada/);
  assert.match(render(opportunity, analysis, 'demo').text, /^🧪 <b>PRÉVIA<\/b> · formato compacto, não é um alerta novo\n\n<b>🟢 VALE CANDIDATAR-SE<\/b>/);
  assert.ok(!render(opportunity, analysis, 'enriched').text.includes('PRÉVIA'));
});

test('the other recommendation headings render', () => {
  const opportunity = makeOpportunity('20', { access: { kind: 'premium_only', publicAt: '2026-05-02T12:00:00.000Z', rawLabel: 'x' } });
  assert.match(render(opportunity, makeAnalysis(opportunity)).text, /🕒 AGUARDAR LIBERAÇÃO/);
  const open = makeOpportunity('21');
  assert.match(render(open, makeAnalysis(open, { recommendation: 'skip' })).text, /🔴 NÃO VALE A PENA/);
});

test('deterministic reasons of the basic filter are translated; unknown text is kept', () => {
  assert.equal(translateReason('strong signals: HTML, CSS'), 'sinais fortes: HTML, CSS');
  assert.equal(translateReason('category "Web" is directly relevant'), 'categoria "Web" é diretamente relevante');
  assert.equal(translateReason('status is cancelled'), 'situação: cancelada');
  assert.equal(translateReason('no interest signals, but the category is non-specific ("Outra Categoria")'), 'sem sinais de interesse, mas a categoria é genérica ("Outra Categoria")');
  assert.equal(translateReason('something unexpected'), 'something unexpected');
});

test('the basic message is pt-BR, escaped and short', () => {
  const opportunity = makeOpportunity('24', { title: 'Site <b>&</b>' });
  const message = formatOpportunityMessage(opportunity, makeFilter('review'), { sourceLabels: { fake: '99Freelas' } });
  assert.match(message, /<b>🟡 PARA REVISAR<\/b>/);
  assert.match(message, /Site &lt;b&gt;&amp;&lt;\/b&gt;/);
  assert.match(message, /Orçamento do cliente: em aberto \(sem valor informado\)/);
  assert.match(message, /Propostas: 1 · Interessados: 2/);
  assertBalancedTags(message);
});
