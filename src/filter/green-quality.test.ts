import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Opportunity } from '../domain/opportunity.js';
import { donBrunoProfile } from '../profile/don-bruno.js';
import type { InterestProfile } from '../profile/interest-profile.js';
import { makeOpportunity, NOW } from '../testing/fixtures.js';
import { translateReason } from '../notify/translate-reasons.js';
import { mainCaveat } from './caveats.js';
import { evaluateOpportunity } from './opportunity-filter.js';

// basic-v9: a green needs the central task inside the offered skills and a SPECIFIC skill up front.
const project = (over: Partial<Opportunity> = {}): Opportunity =>
  makeOpportunity('1', {
    sourceId: 'freelancer',
    category: 'Websites, IT & Software',
    subcategory: null,
    employmentType: 'freelance',
    proposalCount: 30,
    budget: { currency: 'USD', kind: 'fixed', min: 200, max: 500 },
    sourceMetadata: { language: 'en' },
    ...over,
  });
const run = (opportunity: Opportunity, profile: InterestProfile = donBrunoProfile) => evaluateOpportunity(opportunity, profile, NOW);
const decisionOf = (title: string, description: string, over: Partial<Opportunity> = {}) => run(project({ title, description, ...over })).decision;
const padTo = (text: string, length: number): string => `${text} ${'We have run this small family business for many years and we enjoy working with people. '.repeat(20)}`.slice(0, length);

// ---------- generic words and tags are not a skill ----------
test('"responsive", "front-end", "website" and tags alone never make a green; a specific skill up front does', () => {
  const generic = run(project({ title: 'Responsive front-end website', description: 'I need a modern, responsive website for my small consulting business, with a home page, a services page and a contact page. The design is ready and I will send the texts.', skills: ['HTML', 'CSS', 'JavaScript'] }));
  assert.equal(generic.decision, 'review');
  assert.ok(generic.reasons.includes('no specific technical skill in the title or the start of the description'));
  assert.equal(mainCaveat(generic.reasons), 'no specific technical skill in the title or the start of the description');
  for (const specific of ['HTML and CSS website for a consulting business', 'WordPress website for a consulting business', 'Landing page for a consulting business', 'React front-end for a consulting business', 'Fix a JavaScript bug on my website']) {
    assert.equal(decisionOf(specific, 'I need a small website for my consulting business, with a home page, a services page and a contact page. The design is ready and I will send the texts.'), 'top_match', specific);
  }
  // A weak signal that names an offered skill (API, bot, automation) is specific; "site" and "web" are not.
  assert.equal(decisionOf('Telegram bot for my orders', 'A small Telegram bot that tells me when a new order arrives and lets me mark it as shipped. I will provide the account.', { subcategory: 'Integrações e Automações' }), 'shortlist', 'bot and Telegram are offered skills, in a directly relevant category');
  assert.equal(run(project({ title: 'Site na web', description: 'Preciso de um site para a minha empresa, com informações da empresa, serviços e contato, de forma simples e rápida.' })).decision, 'review');
});

test('the start of the description is the first 600 characters: a specific skill inside it counts, one after it does not', () => {
  assert.equal(decisionOf('Website for my bakery', `${padTo('', 560)} We will use HTML and CSS.`), 'top_match', 'named at about 570 characters');
  assert.equal(decisionOf('Website for my bakery', `${padTo('', 700)} We will use HTML and CSS.`), 'review', 'named after 700 characters');
});

// ---------- the mandatory cases of the audit ----------
const GEMINI =
  'I need a skilled full-stack developer to complete the Google Gemini Enterprises Lab project. The project is web-based and requires both front-end and back-end development expertise. Ideal Skills and Experience: - Proficiency in web development technologies (HTML, CSS, JavaScript, etc.) - Experience with back-end frameworks and databases - Strong problem-solving skills - Ability to work within a budget and meet deadlines.';
const REALTIME =
  'We run a statistics website for live casino game shows. We need a developer to build a real-time data tracker for two specific live game-show tables: capture each round\'s outcome as it happens and feed it to our website\'s stats pages. Most of our platform is already built (backend endpoints, cache, front-end UI, SEO). The tracker must run headless, reconnect on its own and store results with a WebSocket feed.';
const RENTAL =
  'I’m ready to launch the first, stripped-down version of an online “rental boyfriend” service and need a developer who can focus entirely on one core feature: user profiles with bios. Here’s what I need built: • A clean sign-up and login flow for “boyfriends” and for visitors who simply want to browse. • Profile pages that let each boyfriend upload photos, write a short and long bio, list interests. • A responsive layout and a database that stores everything safely.';
const SAAS =
  'We are seeking an experienced Laravel developer/team to build a highly scalable, multi-tenant B2B SaaS core framework. We can provide Logo and Website Design mockup with CSS guidelines. The application functions as an abstract, sequential learning management engine where administrators can structure content pathways for individual users. The project must utilize Filament PHP for the administrative panel. Back-end only: REST endpoints, queues and a database.';

test('Google Gemini Enterprises Lab: full-stack with back-end and databases is a doubt (review), never a green', () => {
  const result = run(project({ title: 'Google Gemini Enterprises Lab Development', description: GEMINI, skills: ['Python', 'Full Stack Development', 'Backend Development', 'HTML', 'CSS'], budget: { currency: 'INR', kind: 'hourly', min: 750, max: 1250 } }));
  assert.equal(result.decision, 'review');
  assert.ok(result.reasons.some((reason) => reason.startsWith('back-end work beside an available skill')));
});

test('Real-Time Live Game Data Tracker: a Node.js scraper with a headless browser is a skip, not a green', () => {
  const result = run(project({ title: 'Real-Time Live Game Data Tracker — Node.js / Headless Browser Developer', description: REALTIME, skills: ['JavaScript', 'Node.js', 'Web Scraping', 'Docker'], proposalCount: 147 }));
  assert.equal(result.decision, 'skip');
  assert.match(result.reasons[0]!, /^back-end work is central: "node js" in the title/);
});

test('Rental Boyfriend Platform: judged by the central back-end (sign-up, login, uploads, database), not by the subject', () => {
  const backendCentral = run(project({ title: 'Rental Boyfriend Profile Platform', description: RENTAL, skills: ['PHP', 'Python', 'Django', 'Laravel'] }));
  assert.equal(backendCentral.decision, 'skip');
  assert.match(backendCentral.reasons[0]!, /^back-end work is central: /);
  assert.ok(!/boyfriend|theme|content/i.test(backendCentral.reasons[0]!), 'the reason is technical, never about the subject');
  // The same subject as a plain front-end job, with a specific skill up front and no back-end weight, is judged like any other.
  const frontend = run(project({ title: 'HTML and CSS landing page for a rental boyfriend service', description: 'A single landing page in HTML and CSS for an online rental boyfriend service: hero, how it works, prices and a contact form. Design is ready, mobile first, and I will send the photos and the texts for it.' }));
  assert.equal(frontend.decision, 'top_match');
});

test('Abstract Micro-Learning SaaS: Laravel and multi-tenant SaaS dominate the brief, so it is a skip', () => {
  const result = run(project({ title: 'Abstract Micro-Learning SaaS', description: SAAS, skills: ['PHP', 'Laravel', 'HTML'], proposalCount: 238, budget: { currency: 'EUR', kind: 'fixed', min: 30, max: 250 } }));
  assert.equal(result.decision, 'skip');
  assert.match(result.reasons[0]!, /^back-end work is central: /);
});

test('the solid greens of the audit stay green (they name a specific skill in the title or the first 600 characters)', () => {
  const solid: [string, string][] = [
    ['HTML/CSS Website Frontend Development', 'I need a clean, fast website built from scratch in HTML, CSS and a little JavaScript, with a home page, an about page and a contact form. Design files are ready.'],
    ['Add course listing and registration to WordPress site', 'My WordPress site needs a course listing page and a simple registration form for each course. I already have the theme and the content and only need the pages built.'],
    ['Engaging WordPress Profile Site', 'I need a personal profile site on WordPress with an about section, a gallery and a contact form. I will supply the content and the pictures.'],
    ['Modern Responsive E-Commerce Website', 'Build a modern, responsive shop in HTML, CSS and React with product pages, a cart and a checkout summary. Payment is by PayPal, which I already have. Design is ready.'],
    ['CockroachJobs Listing Pages Development', `${padTo('I need a set of brand-new job listing inner pages for CockroachJobs.in. Before you place a bid, please browse the live site so you understand the layout, typography and component spacing. Scope: build the listing pages, the detail page and the filters, mirroring the current design pixel for pixel.', 540)} Use HTML, CSS and JavaScript.`],
  ];
  for (const [title, description] of solid) {
    const decision = run(project({ title, description, proposalCount: 64, budget: { currency: 'USD', kind: 'fixed', min: 130, max: 390 } })).decision;
    assert.equal(decision, 'shortlist', title);
  }
});

test('Rapid Event Ticketing Landing Page stays a review (deadline and a transactional main delivery), never a skip or a green', () => {
  const result = run(project({ title: 'Rapid Event Ticketing Landing Page', description: 'I need a fully-functional, one-page ticketing solution built and ready to test within the next five hours. HTML, CSS and JavaScript, with the checkout flow: quantity, discount code, Stripe or PayPal and a confirmation.', proposalCount: 68, budget: { currency: 'USD', kind: 'fixed', min: 8, max: 20 } }));
  assert.equal(result.decision, 'review');
});

// ---------- back-end vocabulary, rule by rule ----------
test('back-end as the central task: skip when clearly incompatible, review when a specific skill makes it ambiguous', () => {
  const site = 'A small business website with a home page, a services page and a contact page for my consulting firm. The design is ready and I will send the texts and the photos for each page.';
  assert.equal(decisionOf('Laravel developer for my web app', site), 'skip');
  assert.equal(decisionOf('Node.js API server', site), 'review', 'a simple API is offered, a Node.js server is not: ambiguous');
  assert.equal(decisionOf('Web scraper for product prices', site), 'skip');
  assert.equal(decisionOf('Full-stack developer needed', `${site} Front-end in HTML and CSS.`), 'review', 'a specific skill up front makes it ambiguous');
  assert.equal(decisionOf('WordPress site with a members area', `${site} The members log in and see their invoices in a database.`), 'review', 'WordPress in the title, back-end beside it');
  assert.equal(decisionOf('WordPress site for my firm', site), 'top_match', 'no back-end weight at all');
  // Two distinct weak words (login + database) count as one hit; a single one does not.
  assert.equal(decisionOf('HTML and CSS pages for my firm', `${site} Visitors can log in.`), 'top_match');
  assert.equal(decisionOf('Membership website for my firm', 'A membership website where visitors sign up, log in, upload files and I manage users from an admin panel and a database that stores everything for the whole team.'), 'skip');
  // Three or more strong hits at the start dominate the brief.
  assert.equal(decisionOf('Help with my web project', 'A Laravel and Django platform with a Node.js worker and a multi-tenant database; a bit of CSS on the login page would be welcome as well, thank you for your help.'), 'skip');
});

// ---------- site platforms depend on the configured skills ----------
test('Shopify, Webflow and Wix depend on the profile, not on a global block: not offered means skip or doubt, offered means fine', () => {
  const store = 'A store for my clothing brand with a home page, product pages, a cart and a contact form. The design is ready and I will send the products and the photos for the whole catalogue.';
  assert.equal(decisionOf('Shopify store for a clothing brand', store), 'skip');
  assert.equal(decisionOf('Webflow site for a clothing brand', store), 'skip');
  assert.equal(decisionOf('Wix developer for a clothing brand', store), 'skip');
  assert.equal(decisionOf('Wix developer: quick HTML site conversion', store), 'review', 'a specific skill of the profile in the title makes it ambiguous, not a skip');
  // The same platform, once the profile lists it as a skill, is no longer outside it.
  const withShopify: InterestProfile = { ...donBrunoProfile, strongSignals: [...donBrunoProfile.strongSignals, { term: 'Shopify' }] };
  const offered = run(project({ title: 'Shopify store for a clothing brand', description: store }), withShopify);
  assert.notEqual(offered.decision, 'skip');
  assert.equal(offered.decision, 'top_match');
  assert.equal(run(project({ title: 'Wix developer for a clothing brand', description: store }), withShopify).decision, 'skip', 'only what the profile lists is offered');
});

test('attractiveness never decides compatibility: a cheap, crowded, urgent-free project keeps its decision; only doubts cap it', () => {
  const description = 'A small HTML and CSS website for my consulting business, with a home page, a services page and a contact page. The design is ready and I will send the texts and the photos.';
  assert.equal(decisionOf('HTML and CSS website', description, { budget: { currency: 'USD', kind: 'fixed', min: 5, max: 20 }, proposalCount: 400 }), 'shortlist');
  assert.equal(decisionOf('HTML and CSS website', description, { budget: { currency: 'USD', kind: 'fixed', min: 300, max: 800 }, proposalCount: 12 }), 'top_match');
});

// ---------- 99Freelas takes part in the ladder ----------
const nineNine = (over: Partial<Opportunity>): Opportunity =>
  makeOpportunity('99', {
    sourceId: '99freelas',
    category: 'Web, Mobile & Software',
    subcategory: 'Desenvolvimento Web',
    proposalCount: 20,
    budget: { currency: 'BRL', kind: 'open', min: null, max: null },
    ...over,
  });

test('99Freelas needs no engagement type: it is freelance, its open budget never blocks the green and always blocks the blue', () => {
  const landing = nineNine({ title: 'Landing page para a minha loja', description: 'Preciso de uma landing page responsiva em HTML e CSS para divulgar a minha loja online, com formulário de contato, depoimentos e mapa. Entrego os textos e as fotos em uma semana.' });
  assert.equal(landing.employmentType, undefined);
  const result = run(landing);
  assert.equal(result.decision, 'shortlist');
  assert.ok(!result.reasons.some((reason) => /^employment type|^location|budget currency/.test(reason)), 'nothing is invented for a source that does not publish it');
  assert.equal(run({ ...landing, budget: { currency: 'BRL', kind: 'fixed', min: 800, max: 1200 } }).decision, 'shortlist', 'BRL has no rate: still never blue, never blocked');
});

test('99Freelas: the same quality rules apply in Portuguese (skills, non-technology, back-end, unavailable platform)', () => {
  const texto = 'Preciso de ajuda com o meu projeto para a empresa, com páginas simples, formulário de contato e textos que eu mesmo vou enviar, em até duas semanas de prazo combinado.';
  assert.equal(run(nineNine({ title: 'Integração de sistemas, APIs e automações', description: `Integrar o nosso sistema de vendas com APIs de pagamento de terceiros e automações simples de e-mail, com testes. ${texto}` })).decision, 'shortlist', 'API/integração/automação are specific skills');
  assert.equal(run(nineNine({ title: 'Site para a minha empresa', description: texto })).decision, 'review', 'only generic words ("site")');
  assert.equal(run(nineNine({ title: 'Desenvolvedor Laravel para sistema', description: texto })).decision, 'skip');
  assert.equal(run(nineNine({ title: 'Loja na Shopify', description: texto })).decision, 'skip');
  assert.equal(run(nineNine({ title: 'Assistente virtual para 30 dias', description: 'Procuro uma secretária remota para me ajudar na organização do dia a dia do consultório, com agenda e atendimento.', category: 'Suporte Administrativo', subcategory: 'Outra - Suporte Administrativo' })).decision, 'skip');
});

// ---------- a category never beats an explicit technical deliverable ----------
test('a non-technology category is a review, not a skip, when the title or start names a specific technical skill (the 99Freelas landing page + meta ads)', () => {
  const ads = nineNine({
    title: 'Montar uma landing page e configurar todo parte meta ads',
    description: 'Preciso de uma pessoa que saiba montar a landing page da minha campanha e configurar o meta ads, deixando tudo pronto para começar a campanha ainda este mês, com textos e imagens que eu envio.',
    category: 'Design & Criação',
    subcategory: 'Apresentação',
  });
  const result = run(ads);
  assert.equal(result.decision, 'review');
  assert.ok(result.reasons.includes('category "Design & Criação" is not technology, but a specific technical skill is named up front'));
  assert.equal(mainCaveat(result.reasons), 'category "Design & Criação" is not technology, but a specific technical skill is named up front');
  assert.equal(translateReason(mainCaveat(result.reasons)!), 'categoria "Design & Criação" não é de tecnologia, mas há uma habilidade técnica específica em destaque');
  // The technical part keeps the opportunity alive; it is never a green or a blue with a category outside technology.
  assert.notEqual(result.decision, 'shortlist');

  // The category alone still skips: generic words are no technical deliverable, and a skill named for a non-technical task does not count.
  assert.equal(run(nineNine({ title: 'Site para a minha empresa', description: 'Preciso de um site para a minha empresa, com informações da empresa, serviços e contato, de forma simples e rápida.', category: 'Design & Criação', subcategory: 'Apresentação' })).decision, 'skip');
  assert.equal(decisionOf('Freelance Copywriter', 'Write copy for our landing page.', { category: 'Writing', subcategory: null }), 'skip');
  // The same on a source with a different taxonomy.
  assert.equal(decisionOf('HTML and CSS landing page', 'A landing page in HTML and CSS for my newsletter, with a sign-up form and a short thank-you page. The design is ready and I will send the texts.', { category: 'Writing & Content' }), 'review');
  assert.equal(decisionOf('Blog post writer', 'I need weekly blog posts written for my HTML and CSS tutorials site, about two pages each.', { category: 'Writing & Content' }), 'skip', 'a non-technical main task in a non-technology category');
});

// ---------- the declared language is not trusted against the title itself ----------
test('a title mostly in a non-Latin script under a declared language of the profile is at most a review for an uncertain language, never a skip', () => {
  const arabicTitle = 'موقع ووردبرس احترافي لشركة محاماة';
  const description = 'أحتاج إلى مصمم ومطور WordPress يصوغ تجربة رقمية تليق بمكتب محاماة مرموق، مع صفحات للخدمات والفريق والاتصال، وتصميم متجاوب على الهاتف، وسأرسل النصوص والصور.';
  const arabic = run(project({ title: arabicTitle, description, sourceMetadata: { language: 'en' } }));
  assert.equal(arabic.decision, 'review');
  assert.ok(arabic.reasons.includes('project language uncertain: the title is mostly in a non-Latin script but the source says "en"'));
  assert.equal(translateReason('project language uncertain: the title is mostly in a non-Latin script but the source says "en"'), 'idioma incerto: o título está em escrita não latina, mas a fonte declara "en"');
  assert.equal(mainCaveat(arabic.reasons), 'project language uncertain: the title is mostly in a non-Latin script but the source says "en"');
  // Nothing is detected or translated: the same brief with the source saying nothing, or with a Latin title, is not touched.
  assert.equal(run(project({ title: arabicTitle, description, sourceMetadata: {} })).decision, 'top_match');
  assert.equal(run(project({ title: 'WordPress site for a law firm', description, sourceMetadata: { language: 'en' } })).decision, 'top_match');
  // A title that is mostly Latin with a few foreign letters, or a short one, is not flagged.
  assert.equal(run(project({ title: 'WordPress موقع for a law firm', description, sourceMetadata: { language: 'en' } })).decision, 'top_match');
  assert.equal(run(project({ title: 'ok', description, sourceMetadata: { language: 'en' } })).reasons.some((r) => r.startsWith('project language')), false);
  // A language outside the profile keeps its own, older reason (the new one never doubles it).
  const declaredArabic = run(project({ title: arabicTitle, description, sourceMetadata: { language: 'ar' } }));
  assert.ok(declaredArabic.reasons.includes('project language "ar" is not one of the profile languages'));
  assert.ok(!declaredArabic.reasons.some((r) => r.startsWith('project language uncertain')));
  // It can only lower: an irrelevant project stays a skip.
  assert.equal(run(project({ title: arabicTitle, description: 'أحتاج إلى مترجم لمستند قصير من الإنجليزية إلى العربية خلال يومين.', sourceMetadata: { language: 'en' } })).decision, 'skip');
});
