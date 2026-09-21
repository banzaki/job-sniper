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
    description: 'Vender o PREDPACK, uma biblioteca de cenas de filmes e séries já cortadas para editores. Precisamos de uma página leve e rápida.',
    access: { kind: 'premium_only', publicAt: '2026-05-02T19:37:00.000Z', rawLabel: 'Projeto Exclusivo' },
    ...over,
  });

test('the analysis message follows the approved layout: blocks separated by blank lines, with the saved effort and price', () => {
  const opportunity = restricted('7');
  const analysis = makeAnalysis(opportunity, { recommendation: 'review', score: 55, effort: { minHours: 12, maxHours: 25 }, price: { minBrl: 600, maxBrl: 1250, rationale: 'Base' } }, NOW, brunoCandidate);
  const text = render(opportunity, analysis).text;

  const blocks = text.split('\n\n');
  assert.equal(blocks[0], '<b>🚨 NOVA OPORTUNIDADE</b>');
  assert.equal(blocks[1], '<b>🟡 VALE REVISAR</b>');
  assert.equal(blocks[2], '<b>Landing Page para o PREDPACK</b>\n🌐 99Freelas');
  assert.equal(
    blocks[3],
    ['💰 Orçamento do cliente: em aberto (sem valor informado)', '💡 Preço sugerido pela IA: R$ 600–1.250', '⏱ Esforço estimado: 12–25 horas', '👥 Concorrência: 1 proposta', '🎯 Compatibilidade: média'].join('\n'),
  );
  assert.ok(blocks[4]!.startsWith('<b>📝 O projeto</b>\nVender o PREDPACK, uma biblioteca de cenas'));
  assert.ok(blocks[5]!.startsWith('<b>🤖 Como a IA pode ajudar</b>\n'));
  assert.ok(blocks[6]!.startsWith('<b>⚠️ Atenção</b>\nAcesso restrito na última consulta'));
  assert.equal(blocks[7], '🔗 <a href="https://example.test/project/7">Abrir oportunidade</a>');
  assert.equal(blocks.length, 8);
  assert.ok(visibleLength(text) <= COMPACT_CEILING, `${visibleLength(text)} characters`);
  assertBalancedTags(text);
});

test('the header says why the message exists: a real new alert, an updated analysis, or a format preview', () => {
  const opportunity = makeOpportunity('9');
  const analysis = makeAnalysis(opportunity);
  const real = render(opportunity, analysis, 'enriched').text;
  assert.ok(real.startsWith('<b>🚨 NOVA OPORTUNIDADE</b>\n\n'));
  assert.ok(!/PRÉVIA|não é um alerta novo|ATUALIZADA/.test(real), 'a real opportunity never carries preview text');
  const update = render(opportunity, analysis, 'update').text;
  assert.ok(update.startsWith('<b>🔄 ANÁLISE ATUALIZADA</b>\n\n'));
  assert.ok(!/PRÉVIA|NOVA OPORTUNIDADE/.test(update));
  const demo = render(opportunity, analysis, 'demo').text;
  assert.ok(demo.startsWith('<b>🧪 PRÉVIA DE FORMATO</b>\n\n'));
  assert.ok(!/NOVA OPORTUNIDADE|ATUALIZADA/.test(demo));
});

test('the classification follows the saved recommendation', () => {
  const open = makeOpportunity('10');
  assert.match(render(open, makeAnalysis(open, { recommendation: 'apply' })).text, /<b>🟢 BOA OPORTUNIDADE<\/b>/);
  assert.match(render(open, makeAnalysis(open, { recommendation: 'review' })).text, /<b>🟡 VALE REVISAR<\/b>/);
  const wait = makeOpportunity('11', { access: { kind: 'premium_only', publicAt: '2026-05-02T12:00:00.000Z', rawLabel: 'x' } });
  assert.match(render(wait, makeAnalysis(wait)).text, /<b>🕒 AGUARDAR LIBERAÇÃO<\/b>/);
  assert.match(render(open, makeAnalysis(open, { recommendation: 'skip' })).text, /<b>🔴 NÃO VALE A PENA<\/b>/);
  assert.ok(!/VALE CANDIDATAR-SE/.test(render(open, makeAnalysis(open)).text), 'the former wording is gone');
});

test('nothing is hard-coded: other persisted values render as they are', () => {
  const opportunity = makeOpportunity('8', { title: 'Site institucional', budget: { currency: 'BRL', kind: 'fixed', min: 1500, max: 2500 }, description: 'Um site simples para uma clínica, com três páginas e um formulário.', proposalCount: 14 });
  const analysis = makeAnalysis(opportunity, { price: { minBrl: 2000, maxBrl: 2000, rationale: 'x' }, effort: { minHours: 1, maxHours: 1 }, score: 91 });
  const text = render(opportunity, analysis).text;
  assert.match(text, /💰 Orçamento do cliente: R\$ 1\.500–2\.500\n/);
  assert.match(text, /💡 Preço sugerido pela IA: R\$ 2\.000\n/);
  assert.match(text, /⏱ Esforço estimado: 1 hora\n/);
  assert.match(text, /👥 Concorrência: 14 propostas\n/);
  assert.match(text, /🎯 Compatibilidade: alta/);
  assert.ok(!/PREDPACK|600|1\.250|21\/09/.test(text), 'no value from another example leaks in');
});

test('the message leaves out the proposal, question lists, internal explanations and any "next messages" promise', () => {
  const opportunity = restricted('12');
  const text = render(opportunity, makeAnalysis(opportunity, {}, NOW, brunoCandidate)).text;
  assert.ok(!/Olá! Li o briefing|Rascunho|Proposta|✍️|Perguntas ao cliente|Já existe um layout/.test(text));
  assert.ok(!/Por que essa nota|Requisitos essenciais|Verificadas:|Lacunas|\/100|confiança/.test(text));
  assert.ok(!/próximas mensagens|detalhes nas/i.test(text));
  assert.ok(!/capped at|Essential skills not fully verified|basic-v\d|ai-v\d|\+p[0-9a-f]{8}/.test(text), 'no internal names or English notes');
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

test('Atenção holds only the main caveat: restricted access, then unverified skills, then the AI risk; none, no block', () => {
  const opportunity = makeOpportunity('13');
  const fresh = makeAnalysis(opportunity, { essentialSkills: ['HTML', 'design responsivo', 'Photoshop'], matchedSkills: ['HTML'], missingSkills: [] }, NOW, brunoCandidate);
  assert.match(render(opportunity, fresh).text, /<b>⚠️ Atenção<\/b>\nCompetências essenciais ainda não verificadas: HTML, design responsivo\./);

  // Stored before the alias was known: listed as "not covered"; the display regroups it.
  const legacy: MatchAnalysis = { ...fresh, verification: { ...fresh.verification, unverified: ['HTML'], notCovered: ['design responsivo', 'Photoshop'] } };
  const legacyText = render(opportunity, legacy).text;
  assert.match(legacyText, /não verificadas: HTML, design responsivo\./);
  assert.ok(!/Ausentes/.test(legacyText), 'a known alias is not "absent"');

  const onlyAbsent: MatchAnalysis = { ...fresh, verification: { ...fresh.verification, unverified: [], learning: [], notCovered: ['Photoshop'] } };
  assert.match(render(opportunity, onlyAbsent).text, /<b>⚠️ Atenção<\/b>\nAusentes no perfil: Photoshop\./);

  const verified = makeAnalysis(opportunity);
  assert.match(render(opportunity, verified).text, /<b>⚠️ Atenção<\/b>\nEscopo pouco detalhado/);
  assert.ok(!render(opportunity, { ...verified, risks: [] }).text.includes('Atenção'), 'nothing to warn about: no block');

  const both = restricted('14');
  const bothText = render(both, makeAnalysis(both, {}, NOW, brunoCandidate)).text;
  assert.equal((bothText.match(/⚠️ Atenção/g) ?? []).length, 1, 'one caveat only');
  assert.match(bothText, /Atenção<\/b>\nAcesso restrito/, 'restricted access comes first');
  assert.ok(!/Competências essenciais/.test(bothText));
});

test('restricted access is worded as an estimate to confirm; open or unknown access adds no claim', () => {
  const future = restricted('15');
  assert.match(render(future, makeAnalysis(future)).text, /Acesso restrito na última consulta\. Liberação estimada: 02\/05 às 16h37 \(Brasília\); confirmar no site\./);
  const past = restricted('16', { access: { kind: 'premium_only', publicAt: '2026-04-30T12:00:00.000Z', rawLabel: 'x' } });
  assert.match(render(past, makeAnalysis(past)).text, /a liberação estimada \(30\/04 às 09h00\) já passou\. Confirmar no site\./);
  const noTime = restricted('17', { access: { kind: 'premium_only', publicAt: null, rawLabel: 'x' } });
  assert.match(render(noTime, makeAnalysis(noTime)).text, /horário de liberação desconhecido\. Confirmar no site\./);
  for (const kind of ['public', 'unknown'] as const) {
    const plain = makeOpportunity('18', { access: { kind, publicAt: null, rawLabel: null } });
    const text = render(plain, makeAnalysis(plain, { risks: [] })).text;
    assert.ok(!/liberad|aberta a todos|pode se candidatar|Acesso restrito/i.test(text), kind);
  }
});

test('very long fields are tightened, never cut mid-tag, and never exceed the ceiling', () => {
  const opportunity = makeOpportunity('19', { title: 'T'.repeat(300), description: 'Uma descrição que não termina nunca, com várias palavras seguidas. '.repeat(60) });
  const analysis = makeAnalysis(opportunity, {}, NOW, brunoCandidate);
  const long: MatchAnalysis = { ...analysis, risks: Array.from({ length: 12 }, (_, i) => `Risco ${i} ${'r'.repeat(290)}`) };
  for (const mode of ['enriched', 'update', 'demo'] as const) {
    const text = render(opportunity, long, mode).text;
    assert.ok(visibleLength(text) <= COMPACT_CEILING, `${mode}: ${visibleLength(text)}`);
    assertBalancedTags(text);
    assert.match(text, /Abrir oportunidade<\/a>$/);
  }
});

test('external text is escaped everywhere, and only http(s) links are linked', () => {
  const opportunity = makeOpportunity('20', { title: '<script>alert(1)</script> & "x"', description: 'Preciso de <b>uma</b> landing page em HTML & CSS para hoje.', url: 'https://example.test/?a=1&b="2"' });
  const text = render(opportunity, makeAnalysis(opportunity)).text;
  assert.ok(!text.includes('<script>') && !text.includes('<b>uma</b>'));
  assert.match(text, /&lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; &quot;x&quot;/);
  assert.match(text, /&lt;b&gt;uma&lt;\/b&gt; landing page em HTML &amp; CSS/);
  assert.match(text, /href="https:\/\/example\.test\/\?a=1&amp;b=%22 ?2%22"|href="https:\/\/example\.test\/\?a=1&amp;b=%222%22"/);
  assertBalancedTags(text);
  const unsafe = makeOpportunity('21', { url: 'javascript:alert(1)' });
  assert.ok(!render(unsafe, makeAnalysis(unsafe)).text.includes('href='));
});

test('deterministic reasons of the basic filter are translated; unknown text is kept', () => {
  assert.equal(translateReason('strong signals: HTML, CSS'), 'sinais fortes: HTML, CSS');
  assert.equal(translateReason('category "Web" is directly relevant'), 'categoria "Web" é diretamente relevante');
  assert.equal(translateReason('status is cancelled'), 'situação: cancelada');
  assert.equal(translateReason('no interest signals, but the category is non-specific ("Outra Categoria")'), 'sem sinais de interesse, mas a categoria é genérica ("Outra Categoria")');
  assert.equal(translateReason('something unexpected'), 'something unexpected');
});

test('the basic message of a 99Freelas project is pt-BR, escaped, in the shared layout and short', () => {
  const opportunity = makeOpportunity('24', { title: 'Site <b>&</b>' });
  const message = formatOpportunityMessage(opportunity, makeFilter('review'), { sourceLabels: { fake: '99Freelas' }, now: NOW });
  assert.ok(message.startsWith('<b>🚨 NOVA OPORTUNIDADE</b>\n\n<b>🟡 VALE REVISAR</b>\n\n<b>Site &lt;b&gt;&amp;&lt;/b&gt;</b>\n🌐 99Freelas'));
  assert.match(message, /💰 Orçamento: em aberto \(sem valor informado\)/);
  assert.match(message, /👥 Concorrência: 1 proposta/);
  assert.match(message, /🧩 Habilidades: HTML/);
  assert.ok(!/⏱|💡|Preço sugerido|Esforço/.test(message), 'no effort or suggested price without a saved analysis');
  assert.ok(visibleLength(message) <= COMPACT_CEILING);
  assertBalancedTags(message);
});
