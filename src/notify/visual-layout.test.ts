import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FilterResult } from '../domain/filter-result.js';
import type { Opportunity } from '../domain/opportunity.js';
import { aiHelpFor, isSafeForAiHelp } from './ai-help.js';
import { basicAttention, compatibilityLabel, relevantSkills } from './blocks.js';
import { formatOpportunityMessage } from './format-message.js';
import { visibleLength } from './html.js';
import { substantiveSummary } from './layout.js';
import { makeOpportunity, NOW } from '../testing/fixtures.js';

const summary = (text: string, max = 260) => substantiveSummary(text, max);

// ---------- the summary of the work ----------
test('a lone greeting is never the summary: Hello!, Hi there, Olá, Bom dia, Dear freelancer', () => {
  const real = 'I need a responsive landing page built in React for my new product.';
  for (const greeting of ['Hello!', 'Hi there', 'Hi there,', 'Hey!', 'Olá', 'Olá!', 'Bom dia', 'Bom dia!', 'Dear freelancer,', 'Dear Freelancer', 'Good morning!', 'Hello everyone!', 'Boa tarde,']) {
    assert.equal(summary(`${greeting}\n${real}`), real, greeting);
    assert.equal(summary(`${greeting} ${real}`), real, `${greeting} (same line)`);
  }
  assert.equal(summary('Hello!'), null);
  assert.equal(summary('Hi there'), null);
  assert.equal(summary('Olá'), null);
  assert.equal(summary('Dear freelancer,'), null);
});

test('a greeting glued to the real text is removed and the author\'s own words remain untouched', () => {
  assert.equal(summary('Hi there, I need a landing page for a coffee shop with a menu and a map.'), 'I need a landing page for a coffee shop with a menu and a map.');
  assert.equal(summary('Olá! Preciso de um site institucional simples, com três páginas e formulário.'), 'Preciso de um site institucional simples, com três páginas e formulário.');
  assert.equal(summary('Hello, hello! Please fix the checkout bug that appears on mobile phones only.'), 'Please fix the checkout bug that appears on mobile phones only.');
});

test('prefixes such as Descrição, Project description, Objective and numbering are removed', () => {
  const body = 'Criar uma página de vendas rápida, com foco em quem chega pelo celular.';
  for (const prefix of ['Descrição: ', 'Descrição do projeto - ', 'Project description: ', 'Objective: ', 'Objetivo: ', '1. ', '2) ', '- ', '• ']) {
    assert.equal(summary(`${prefix}${body}`), body, JSON.stringify(prefix));
  }
  assert.equal(summary('1. Objetivo Vender o PREDPACK, uma biblioteca de cenas para editores de vídeo.'), 'Vender o PREDPACK, uma biblioteca de cenas para editores de vídeo.');
  assert.equal(summary('1. Objetivo\nVender o PREDPACK, uma biblioteca de cenas para editores de vídeo.'), 'Vender o PREDPACK, uma biblioteca de cenas para editores de vídeo.');
});

test('generic headings, very short lines and pleasantries are skipped; the first substantive stretch wins', () => {
  const real = 'We need a booking form connected to Google Calendar with e-mail confirmations.';
  const text = ['Project Description', 'Requirements:', 'About us', 'Details', 'Thanks for reading!', 'Please read carefully before bidding on this job.', 'I hope this message finds you well.', 'Need help', real].join('\n');
  assert.equal(summary(text), real);
  assert.equal(summary(['Project Description', 'Overview', 'Skills:'].join('\n')), null);
});

test('a stretch needs a reasonable size: about 30 characters and a few words', () => {
  assert.equal(summary('Need a logo.'), null, 'too short');
  assert.equal(summary('Make me a website please now'), null, 'under 30 characters');
  assert.equal(summary('Build a small landing page.'), null, 'under 30 characters');
  assert.equal(summary('Build a small landing page for us.'), 'Build a small landing page for us.');
  assert.equal(summary('Supercalifragilisticexpialidocious-Supercalifragilisticexpialidocious'), null, 'one long word is not a sentence');
});

test('the summary has at most two short sentences, and never rewrites or completes the text', () => {
  const text = 'Preciso de uma landing page para lançar meu curso online. O layout deve ser limpo e responsivo. Entrego o texto e as imagens amanhã. Prazo de duas semanas.';
  assert.equal(summary(text), 'Preciso de uma landing page para lançar meu curso online. O layout deve ser limpo e responsivo.');
  const one = summary('Preciso de uma landing page para lançar meu curso online, com formulário de contato e integração de e-mail marketing em duas semanas. Segunda frase longa demais para caber junto da primeira neste limite curto.', 140);
  assert.ok(one!.length <= 140);
  assert.ok(!one!.includes('Segunda frase'), 'when both do not fit, only the first');
  assert.equal(summary('Só uma frase útil aqui, com detalhes suficientes para passar do mínimo.'), 'Só uma frase útil aqui, com detalhes suficientes para passar do mínimo.');
});

test('a description with nothing useful gives no summary at all, so the block is omitted', () => {
  for (const text of ['', '   ', 'Hello!\nHi there\nOlá\nThanks!', '🙂🙂🙂', 'Project Description\nRequirements\nBudget', '.....', 'a b c d e f g h i j k l m n o p']) {
    assert.equal(summary(text), null, JSON.stringify(text));
  }
  const opportunity = makeOpportunity('1', { description: 'Hello!\nHi there\nThanks for reading!', summary: null });
  const message = formatOpportunityMessage(opportunity, filter('shortlist'), { now: NOW });
  assert.ok(!message.includes('📝 O projeto'), 'no garbage block');
  assert.ok(!/Hello|Hi there/.test(message));
  assert.ok(message.includes('🔗'), 'the rest of the message is intact');
});

// ---------- how AI can help ----------
const work = (title: string, description: string) => ({ title, description });

test('AI help is chosen by fixed rules from the kind of work in the text, and never claims the person masters anything', () => {
  const web = aiHelpFor(work('Landing page', 'Build a responsive landing page in HTML and CSS.'), true)!;
  assert.match(web, /^Acelerar a estrutura inicial, os componentes e a revisão responsiva\./);
  assert.match(aiHelpFor(work('Site em WordPress', 'Ajustar o tema do WordPress.'), true)!, /^Acelerar a montagem das seções, o ajuste do tema/);
  assert.match(aiHelpFor(work('Integração', 'Integrar nossa API de pagamentos ao sistema.'), true)!, /^Ajudar a esboçar as chamadas, o tratamento de erros/);
  assert.match(aiHelpFor(work('Bot', 'Um bot de Telegram para avisar pedidos.'), true)!, /^Ajudar a desenhar o fluxo, escrever o script inicial/);
  for (const text of [web, aiHelpFor(work('x', 'wordpress'), true)!, aiHelpFor(work('x', 'bot'), true)!]) {
    assert.match(text, /Você ainda controla briefing, decisões e entrega\.$/);
    assert.ok(!/você (domina|sabe|é especialista|tem experiência)|dominar|expert/i.test(text), 'no claim of mastery');
  }
});

const BUG_HELP = 'Ajudar a organizar o diagnóstico, levantar hipóteses e montar um checklist de validação. Você executa e confirma cada correção.';

test('priority: a bug or error beats WordPress, an API or integration beats generic front-end, and plain kinds keep their sentence', () => {
  // A bug or error to fix is diagnosis work, whatever the platform.
  assert.equal(aiHelpFor(work('Fix Critical WordPress Errors', 'White screens across several WordPress installs.'), true), BUG_HELP);
  assert.equal(aiHelpFor(work('Correção', 'Corrigir um bug no formulário de contato.'), true), BUG_HELP);
  assert.equal(aiHelpFor(work('Erro no site', 'O checkout mostra um erro ao pagar.'), true), BUG_HELP);
  assert.equal(aiHelpFor(work('Store', 'WordPress store with a bug in the cart and an API.'), true), BUG_HELP, 'bug also beats an API');
  assert.ok(!BUG_HELP.includes('Você ainda controla'), 'the bug sentence has its own closing');
  // An API or integration beats generic front-end and WordPress.
  const integration = /^Ajudar a esboçar as chamadas, o tratamento de erros/;
  assert.match(aiHelpFor(work('Listing pages', 'New pages in HTML, CSS and JavaScript with an integration to our jobs feed.'), true)!, integration);
  assert.match(aiHelpFor(work('Shop', 'WordPress shop that syncs stock through an API.'), true)!, integration);
  // "error handling" describes an integration, not a bug to fix.
  assert.match(aiHelpFor(work('Payments API', 'Connect the API with proper error handling.'), true)!, integration);
  // Common cases.
  assert.match(aiHelpFor(work('WordPress site', 'A WordPress site with a custom theme and five sections.'), true)!, /^Acelerar a montagem das seções, o ajuste do tema e a revisão do conteúdo\./);
  assert.match(aiHelpFor(work('Landing page', 'A responsive page in HTML, CSS and JavaScript.'), true)!, /^Acelerar a estrutura inicial, os componentes e a revisão responsiva\./);
});

test('with no clear or safe signal there is no AI help, and the block is omitted', () => {
  assert.equal(aiHelpFor(work('Logo', 'Two-tone minimalist logo for a coffee brand.'), true), null);
  assert.equal(aiHelpFor(work('Translation', 'Translate our documents from German to Dutch.'), true), null);
  assert.equal(aiHelpFor(work('Landing page', 'Build a landing page in HTML.'), false), null, 'unsafe: omitted');
  assert.equal(aiHelpFor({ title: 'Ads', description: 'Set up campaigns and conversion tracking.' } as Pick<Opportunity, 'title' | 'description'>, true), null);
  assert.equal(isSafeForAiHelp('skip', []), false);
  assert.equal(isSafeForAiHelp('review', ['conflicting or advanced scope: LLM']), false);
  assert.equal(isSafeForAiHelp('review', ['strong skills appear only as tags, not in the title or description']), false);
  assert.equal(isSafeForAiHelp('review', ['technical deliverable is not clear in the title or the start of the description']), false);
  assert.equal(isSafeForAiHelp('review', ['title names non-technical work ("story") but the description starts with a technical deliverable']), false);
  assert.equal(isSafeForAiHelp('shortlist', ['strong signals: HTML']), true);
});

test('skill tags alone never create AI help: only the title and description count', () => {
  const opportunity = makeOpportunity('2', { title: 'Meta and Google ads setup', description: 'Campaigns with tracking for an online shop.', skills: ['HTML', 'CSS', 'JavaScript'] });
  assert.equal(aiHelpFor(opportunity, true), null);
});

// ---------- the message ----------
function filter(decision: FilterResult['decision'], reasons: string[] = ['strong signals: HTML, CSS']): FilterResult {
  return { decision, reasons, matchedKeywords: [], evaluatedAt: NOW.toISOString(), ruleVersion: 'basic-v5' };
}
const projectOpportunity = (over: Partial<Opportunity> = {}): Opportunity =>
  makeOpportunity('3', {
    title: 'Landing page em HTML e CSS',
    description: 'Preciso de uma landing page responsiva em HTML e CSS para divulgar meu curso.',
    budget: { currency: 'BRL', kind: 'fixed', min: 800, max: 1200 },
    proposalCount: 6,
    ...over,
  });

test('the classification of a basic alert: top match is MATCH EXCELENTE, shortlist is OPORTUNIDADE COMPATÍVEL, review is VALE REVISAR', () => {
  const opportunity = projectOpportunity();
  assert.ok(formatOpportunityMessage(opportunity, filter('top_match'), { now: NOW }).includes('<b>🔵 MATCH EXCELENTE</b>'));
  assert.ok(formatOpportunityMessage(opportunity, filter('shortlist'), { now: NOW }).includes('<b>🟢 OPORTUNIDADE COMPATÍVEL</b>'));
  assert.ok(formatOpportunityMessage(opportunity, filter('review'), { now: NOW }).includes('<b>🟡 VALE REVISAR</b>'));
});

test('the header: a real alert says NOVA OPORTUNIDADE and never preview text; a manual preview says PRÉVIA DE FORMATO', () => {
  const opportunity = projectOpportunity();
  const real = formatOpportunityMessage(opportunity, filter('shortlist'), { now: NOW });
  assert.ok(real.startsWith('<b>🚨 NOVA OPORTUNIDADE</b>\n\n'));
  assert.ok(!/PRÉVIA|não é um alerta novo|🧪/.test(real));
  const preview = formatOpportunityMessage(opportunity, filter('shortlist'), { now: NOW, kind: 'preview' });
  assert.ok(preview.startsWith('<b>🧪 PRÉVIA DE FORMATO</b>\n\n'));
  assert.ok(!/NOVA OPORTUNIDADE|não é um alerta novo/.test(preview));
  assert.equal(formatOpportunityMessage(opportunity, filter('shortlist'), { now: NOW, kind: 'new' }), real);
});

test('blocks are separated by blank lines, the message stays compact, and the effort appears only with a saved analysis', () => {
  const text = formatOpportunityMessage(projectOpportunity(), filter('shortlist'), { now: NOW });
  const blocks = text.split('\n\n');
  assert.deepEqual(blocks.map((block) => block.split('\n')[0]), [
    '<b>🚨 NOVA OPORTUNIDADE</b>',
    '<b>🟢 OPORTUNIDADE COMPATÍVEL</b>',
    '<b>Landing page em HTML e CSS</b>',
    '💰 Orçamento: R$ 800–1.200',
    '<b>📝 O projeto</b>',
    '<b>🤖 Como a IA pode ajudar</b>',
    blocks.at(-1)!.split('\n')[0],
  ]);
  assert.ok(blocks.at(-1)!.startsWith('🔗 <a href='));
  assert.ok(visibleLength(text) <= 1000);
  assert.ok(!/⏱|Esforço|💡|Preço sugerido/.test(text), 'nothing is invented: there is no analysis');
});

test('skills shown are the relevant ones, at most four, and only when the filter found any', () => {
  assert.deepEqual(relevantSkills(filter('shortlist', ['strong signals: HTML, CSS, JavaScript, TypeScript, React, WordPress'])), ['HTML', 'CSS', 'JavaScript', 'TypeScript']);
  assert.deepEqual(relevantSkills(filter('review', ['weak signals: site'])), []);
  const text = formatOpportunityMessage(projectOpportunity(), filter('shortlist', ['strong signals: HTML, CSS, JavaScript, TypeScript, React']), { now: NOW });
  assert.ok(text.includes('🧩 Habilidades: HTML, CSS, JavaScript, TypeScript\n'));
  assert.ok(!text.includes('React'));
  assert.ok(!formatOpportunityMessage(projectOpportunity(), filter('review', ['weak signals: site']), { now: NOW }).includes('Habilidades'));
});

test('compatibility is the current filter, in words', () => {
  assert.equal(compatibilityLabel(filter('shortlist', ['strong signals: HTML, CSS'])), 'alta');
  assert.equal(compatibilityLabel(filter('shortlist', ['strong signals: HTML'])), 'média');
  assert.equal(compatibilityLabel(filter('review', ['strong signals: HTML'])), 'média');
  assert.equal(compatibilityLabel(filter('review', ['weak signals: site'])), 'baixa');
});

// ---------- Atenção ----------
test('Atenção holds ONE caveat, by priority: restricted access, language, advanced scope, high competition, then the stored reason', () => {
  const restricted = projectOpportunity({ access: { kind: 'premium_only', publicAt: '2026-05-02T19:37:00.000Z', rawLabel: 'x' } });
  const marketplace = (proposals: number): Opportunity => projectOpportunity({ employmentType: 'freelance', proposalCount: proposals });
  const reasons = ['project language "de" is not one of the profile languages', 'conflicting or advanced scope: LLM', 'seniority in the title: senior'];

  assert.match(basicAttention(restricted, filter('review', reasons), NOW)!, /^Acesso restrito na última consulta\. Liberação estimada: 02\/05 às 16h37 \(Brasília\); confirmar no site\.$/);
  assert.equal(basicAttention(marketplace(100), filter('review', reasons), NOW), 'Idioma do projeto ("de") fora dos idiomas do perfil.');
  assert.equal(basicAttention(marketplace(100), filter('review', reasons.slice(1)), NOW), 'Escopo conflitante ou avançado: LLM.');
  // Crowding is only a warning when nothing more relevant (a real doubt about the work) came first.
  const crowded = 'crowded project (100 proposals): lowers the ranking';
  assert.equal(basicAttention(marketplace(100), filter('shortlist', [crowded]), NOW), 'Concorrência alta: 100 propostas já enviadas.');
  assert.equal(basicAttention(marketplace(300), filter('shortlist', ['very crowded project (300 proposals): lowest priority in its group']), NOW), 'Concorrência muito alta: 300 propostas já enviadas.');
  assert.equal(basicAttention(marketplace(100), filter('review', ['seniority in the title: senior', crowded]), NOW), 'Senioridade no título: senior.');
  assert.equal(basicAttention(marketplace(30), filter('review', ['seniority in the title: senior']), NOW), 'Senioridade no título: senior.');
  assert.equal(basicAttention(marketplace(30), filter('shortlist', ['strong signals: HTML']), NOW), null, 'nothing to warn about');
  assert.equal(basicAttention(projectOpportunity({ proposalCount: 100 }), filter('shortlist', ['strong signals: HTML']), NOW), null, 'a source with no engagement type has no competition scale');
});

test('a message carries a single Atenção block, or none', () => {
  const opportunity = projectOpportunity({ employmentType: 'freelance', proposalCount: 100 });
  const withCaveat = formatOpportunityMessage(opportunity, filter('shortlist', ['strong signals: HTML', 'crowded project (100 proposals): lowers the ranking']), { now: NOW });
  assert.equal((withCaveat.match(/⚠️ Atenção/g) ?? []).length, 1);
  assert.ok(withCaveat.includes('<b>⚠️ Atenção</b>\nConcorrência alta: 100 propostas já enviadas.'));
  assert.ok(!formatOpportunityMessage(projectOpportunity({ employmentType: 'freelance', proposalCount: 12 }), filter('shortlist'), { now: NOW }).includes('Atenção'));
});

// ---------- safety ----------
test('HTML in every external field is escaped, the AI help is a fixed sentence, and an unsafe link is not linked', () => {
  const opportunity = projectOpportunity({
    title: '<b>Site</b> & "loja"',
    description: 'Preciso de <script>alert(1)</script> uma landing page em HTML & CSS para hoje mesmo.',
    url: 'javascript:alert(1)',
  });
  const text = formatOpportunityMessage(opportunity, filter('shortlist'), { now: NOW });
  assert.ok(!text.includes('<script>') && !text.includes('<b>Site</b>'));
  assert.ok(text.includes('&lt;b&gt;Site&lt;/b&gt; &amp; &quot;loja&quot;'));
  assert.ok(!text.includes('href='));
  const link = formatOpportunityMessage(projectOpportunity({ url: 'https://example.test/?a=1&b="2"' }), filter('shortlist'), { now: NOW });
  assert.match(link, /href="https:\/\/example\.test\/\?a=1&amp;b=%22 ?2%22"|href="https:\/\/example\.test\/\?a=1&amp;b=%222%22"/);
});
