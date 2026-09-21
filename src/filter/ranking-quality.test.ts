import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Opportunity } from '../domain/opportunity.js';
import { basicAttention, compatibilityLabel, LOW_BUDGET_TEXT } from '../notify/blocks.js';
import { formatOpportunityMessage } from '../notify/format-message.js';
import { translateReason } from '../notify/translate-reasons.js';
import { donBrunoProfile } from '../profile/don-bruno.js';
import type { ExchangeRateLookup, ObservedRate } from '../storage/exchange-rate-store.js';
import { makeOpportunity, NOW } from '../testing/fixtures.js';
import { budgetInUsd } from './budget.js';
import { mainCaveat } from './engagement-policy.js';
import { evaluateOpportunity } from './opportunity-filter.js';
import { veryShortDeadlineHours } from './scope-risk.js';

// basic-v8: the commercial ladder. Technical compatibility is judged apart from attractiveness.
const DESCRIPTION =
  'A responsive landing page for my bakery in React, HTML and CSS: hero, menu, opening hours, a contact form and a map. Mobile first, delivered in two weeks, and I will supply the texts and the photos.';
const freelancerProject = (over: Partial<Opportunity> = {}): Opportunity =>
  makeOpportunity('1', {
    sourceId: 'freelancer',
    title: 'Responsive landing page in React',
    description: DESCRIPTION,
    category: 'Websites, IT & Software',
    subcategory: null,
    employmentType: 'freelance',
    proposalCount: 30,
    budget: { currency: 'USD', kind: 'fixed', min: 200, max: 500 },
    sourceMetadata: { language: 'en' },
    ...over,
  });
const ratesOf = (entries: Record<string, ObservedRate>): ExchangeRateLookup => ({ lookup: (sourceId, currency) => entries[`${sourceId}:${currency}`] ?? null });
const evaluate = (opportunity: Opportunity, rates?: ExchangeRateLookup) => evaluateOpportunity(opportunity, donBrunoProfile, NOW, rates);
const decision = (over: Partial<Opportunity>) => evaluate(freelancerProject(over)).decision;

// ---------- the ladder ----------
test('a compatible project with a good budget and up to 60 proposals is a top match; the same with 61 is a shortlist', () => {
  const top = evaluate(freelancerProject());
  assert.equal(top.decision, 'top_match');
  assert.ok(top.reasons.some((reason) => reason.startsWith('top match: ')));
  assert.equal(decision({ proposalCount: 60 }), 'top_match');
  assert.equal(decision({ proposalCount: 61 }), 'shortlist');
  assert.equal(decision({ proposalCount: null }), 'top_match', 'an unpublished count does not block it');
  assert.equal(decision({ budget: { currency: 'USD', kind: 'hourly', min: 8, max: 20 } }), 'top_match', 'the hourly floor');
  assert.equal(decision({ budget: { currency: 'USD', kind: 'fixed', min: 50, max: null } }), 'top_match', 'the floor itself, open above');
});

test('technical compatibility is not lowered by budget or competition: they are caveats that only lower the ranking', () => {
  const cheap = evaluate(freelancerProject({ budget: { currency: 'USD', kind: 'fixed', min: 10, max: 40 } }));
  assert.equal(cheap.decision, 'shortlist', 'a cheap compatible site stays green');
  assert.ok(cheap.reasons.includes('fixed budget of about US$ 40 is below the US$ 50 floor'));
  assert.equal(decision({ budget: { currency: 'USD', kind: 'fixed', min: 30, max: 250 } }), 'shortlist', 'a range that crosses the floor stays green');
  assert.equal(decision({ budget: { currency: 'USD', kind: 'hourly', min: 2, max: 7 } }), 'shortlist');
  assert.equal(decision({ budget: { currency: 'USD', kind: 'fixed', min: 10, max: null } }), 'shortlist');
  assert.equal(decision({ budget: null }), 'shortlist', 'no budget: not a top match, still compatible');
  assert.equal(decision({ budget: { currency: 'USD', kind: 'open', min: null, max: null } }), 'shortlist');
  assert.equal(decision({ proposalCount: 100 }), 'shortlist', 'a crowded compatible site stays green');
  const swamped = evaluate(freelancerProject({ proposalCount: 300 }));
  assert.equal(swamped.decision, 'shortlist', 'more than 150 is not a skip and not yellow');
  assert.ok(swamped.reasons.includes('very crowded project (300 proposals): lowest priority in its group'));
  // The technical label does not fall because of budget or competition.
  const label = (filter: ReturnType<typeof evaluate>) => compatibilityLabel(filter);
  assert.equal(label(evaluate(freelancerProject())), label(evaluate(freelancerProject({ budget: { currency: 'USD', kind: 'fixed', min: 1, max: 2 }, proposalCount: 400 }))) === 'alta' ? 'alta' : 'never');
});

test('the top match needs everything: a strong skill up front, a clear and modest scope, a budget fully above the floor', () => {
  assert.equal(decision({ description: 'A landing page in React and HTML for a bakery, please.' }), 'shortlist', 'too little said to call the scope clear');
  assert.equal(decision({ title: 'Marketplace landing page in React' }), 'shortlist', 'a marketplace is a large scope');
  assert.equal(decision({ description: `${DESCRIPTION} ${'More detail about every section of the page. '.repeat(100)}` }), 'shortlist', 'a very long brief is a large scope');
});

test('a specific skill must be up front: named only deep in a long brief the project is neither a top match nor a green, it is a review', () => {
  const filler = 'We are a family bakery that has been around for many years and we love our customers and our town. '.repeat(9);
  const deep = evaluate(freelancerProject({ title: 'Website for my bakery', description: `${filler}The page should use HTML and CSS.` }));
  assert.equal(deep.decision, 'review');
  assert.ok(deep.reasons.includes('no specific technical skill in the title or the start of the description'));
});

// ---------- exchange rates: per source and currency, valid for 24 hours ----------
test('a non-USD budget uses the rate the opportunity carries, or the cached rate of the same source and currency, for 24 hours', () => {
  const inr = (over: Partial<Opportunity> = {}) => freelancerProject({ budget: { currency: 'INR', kind: 'fixed', min: 12_500, max: 37_500 }, ...over });
  // Own rate, fresh (fetchedAt = now).
  assert.equal(evaluate(inr({ sourceMetadata: { language: 'en', exchangeRateToUsd: 0.010439 } })).decision, 'top_match');
  // No rate at all: still compatible, only never a top match. The budget is not touched or dropped.
  const noRate = evaluate(inr());
  assert.equal(noRate.decision, 'shortlist');
  assert.ok(noRate.reasons.includes('budget currency "INR" has no fresh USD conversion: not a top match'));
  assert.equal(mainCaveat(noRate.reasons), null, 'and it is not a caveat to show');
  // The cache serves an older row of the same source and currency, when recent...
  const recent: ObservedRate = { rateToUsd: 0.0104, observedAt: new Date(NOW.getTime() - 3 * 3_600_000).toISOString() };
  assert.equal(evaluate(inr(), ratesOf({ 'freelancer:INR': recent })).decision, 'top_match');
  assert.equal(evaluate(inr(), ratesOf({ 'freelancer:INR': { ...recent, observedAt: new Date(NOW.getTime() - 24 * 3_600_000).toISOString() } })).decision, 'top_match', 'exactly 24 hours is still valid');
  // ...but not when expired, and not for another source or currency.
  const expired: ObservedRate = { ...recent, observedAt: new Date(NOW.getTime() - 24 * 3_600_000 - 1000).toISOString() };
  assert.equal(evaluate(inr(), ratesOf({ 'freelancer:INR': expired })).decision, 'shortlist');
  assert.equal(evaluate(inr(), ratesOf({ 'remotive:INR': recent })).decision, 'shortlist');
  assert.equal(evaluate(inr(), ratesOf({ 'freelancer:EUR': recent })).decision, 'shortlist');
  // A row's own rate expires with its collection time too.
  const stale = inr({ fetchedAt: new Date(NOW.getTime() - 30 * 3_600_000).toISOString(), sourceMetadata: { language: 'en', exchangeRateToUsd: 0.010439 } });
  assert.equal(evaluate(stale).decision, 'shortlist');
  assert.equal(evaluate(stale, ratesOf({ 'freelancer:INR': recent })).decision, 'top_match', 'the recent cache rescues an old row');
  // Nothing about the currency estimate is invented: bad rates are refused.
  for (const bad of [0, -1, Number.NaN]) assert.equal(evaluate(inr({ sourceMetadata: { language: 'en', exchangeRateToUsd: bad } })).decision, 'shortlist', `rate ${bad}`);
  assert.equal(decision({ budget: { currency: '', kind: 'fixed', min: 1000, max: 2000 } }), 'shortlist');
});

test('a converted low or crossing budget is a caveat, in US$ with a Brazilian format in the message', () => {
  const rates = ratesOf({ 'freelancer:INR': { rateToUsd: 0.010439, observedAt: NOW.toISOString() } });
  const crossing = evaluate(freelancerProject({ budget: { currency: 'INR', kind: 'hourly', min: 750, max: 1250 } }), rates);
  assert.equal(crossing.decision, 'shortlist');
  assert.ok(crossing.reasons.includes('hourly budget range of about US$ 7.8–13/h crosses the US$ 8/h floor'));
  assert.equal(translateReason(crossing.reasons.find((reason) => reason.includes('budget range'))!), 'faixa de orçamento (cerca de US$ 7,8–13/h) atravessa o piso de US$ 8/h');
  const wide = evaluate(freelancerProject({ budget: { currency: 'INR', kind: 'fixed', min: 1500, max: 12_500 } }), rates);
  assert.equal(translateReason(wide.reasons.find((reason) => reason.includes('budget range'))!), 'faixa de orçamento (cerca de US$ 16–130) atravessa o piso de US$ 50');
  assert.ok(!/ to /.test(translateReason(wide.reasons.find((reason) => reason.includes('budget range'))!)), 'never "16 to 130"');
  assert.deepEqual(budgetInUsd(freelancerProject({ budget: { currency: 'EUR', kind: 'hourly', min: 10, max: 20 }, sourceMetadata: { exchangeRateToUsd: 1.5 } }), NOW), { status: 'ok', kind: 'hourly', minUsd: 15, maxUsd: 30 });
  assert.deepEqual(budgetInUsd(freelancerProject({ budget: { currency: 'EUR', kind: 'fixed', min: 1, max: 2 } }), NOW), { status: 'unconvertible', currency: 'EUR' });
  assert.deepEqual(budgetInUsd(freelancerProject({ budget: null }), NOW), { status: 'none' });
});

// ---------- what is not a project for this profile ----------
test('regression: the cases of the sweep', () => {
  const rapid = evaluate(
    freelancerProject({
      title: 'Rapid Event Ticketing Landing Page',
      description:
        'I need a fully-functional, one-page ticketing solution built and ready to test within the next five hours. It must include the front-end layout and the checkout flow: visitors choose a quantity, apply a discount code, pay securely (Stripe or PayPal) and get a confirmation. HTML, CSS and JavaScript.',
      proposalCount: 68,
      budget: { currency: 'USD', kind: 'fixed', min: 8, max: 20 },
    }),
  );
  assert.equal(rapid.decision, 'review', 'complex transaction and an absurd deadline');
  assert.ok(rapid.reasons.includes('very short deadline (about 5 hours): at most a review'));
  assert.ok(rapid.reasons.includes('transactional scope (payments or checkout): at most a review'));

  const cases: [string, Partial<Opportunity>, string][] = [
    ['payroll', { title: 'Environmental Admin & Payroll Coordinator', description: 'I run a habitat-restoration company. The heartbeat of the job is keeping our timecards and payroll straight in QuickBooks and ADP. Occasionally update the pages (HTML, WordPress).', skills: ['PHP', 'HTML', 'Payroll'] }, 'skip'],
    ['story editor', { title: 'Text-Based Children’s Story Editor', description: 'I need someone to polish my children’s stories, fix the grammar and keep a warm voice. Skills: JavaScript, React.', skills: ['JavaScript', 'Editing'] }, 'skip'],
    ['chat support', { title: 'Part-Time Chat Support', description: 'I’m looking for reliable help to cover incoming chat messages on a part-time basis, answering customers politely and quickly through the website chat window.' }, 'skip'],
    ['python and rust', { title: 'I need Python-Rust library experience developer', description: 'A developer with strong Python and Rust experience to build a small library, with tests and documentation for the team.', skills: ['Python', 'Rust', 'HTML'] }, 'skip'],
    ['mobile app', { title: 'Mobile App Comment Section Feature', description: 'We already have an app; add a comment section to it with replies and likes for our users on Android and iOS.' }, 'skip'],
    ['cross platform mobile', { title: 'Cross-Platform Mobile App Development', description: 'Build a cross platform mobile application with React Native and Flutter for iOS and Android, with push notifications.' }, 'skip'],
    ['meta ads', { title: 'Setup Meta and Google Ad Account With Tracking For Ecom Website', description: 'I am ready to start paid acquisition for my e-commerce site and need Google Ads and Meta Ads built from scratch with conversion tracking.', skills: ['HTML'] }, 'skip'],
  ];
  for (const [name, over, expected] of cases) assert.equal(decision(over), expected, name);
});

test('regression: compatible sites are green or blue, and an ordinary shop that mentions PayPal is not yellow', () => {
  assert.equal(decision({ budget: { currency: 'USD', kind: 'fixed', min: 5, max: 20 } }), 'shortlist', 'a compatible, cheap site');
  assert.equal(decision({ proposalCount: 120 }), 'shortlist', 'a compatible, crowded site');
  assert.equal(decision({}), 'top_match', 'a compatible site, a good budget and few proposals');
  const shop = evaluate(
    freelancerProject({
      title: 'E-commerce website for a clothing brand',
      description: 'Build a responsive e-commerce website in HTML, CSS and JavaScript for my clothing brand, with a catalogue, product pages and a cart. Customers can pay with PayPal, which is the only payment method I use for now.',
    }),
  );
  assert.ok(['top_match', 'shortlist'].includes(shop.decision), shop.decision);
  assert.ok(!shop.reasons.some((reason) => reason.startsWith('transactional scope')));
  const stripeMention = evaluate(freelancerProject({ description: `${DESCRIPTION} Payment is by Stripe or PayPal, whichever is simpler.` }));
  assert.ok(!stripeMention.reasons.some((reason) => reason.startsWith('transactional scope')));
});

test('a transactional MAIN delivery is a review: payments, checkout, subscriptions, ticketing, a payment gateway to implement or fix', () => {
  const central = (title: string, description = DESCRIPTION) => evaluate(freelancerProject({ title, description }));
  for (const title of ['Custom payment gateway integration', 'Fix Stripe checkout on my site', 'Subscription billing for a web app', 'Event ticketing website in React', 'Booking system with payments']) {
    const result = central(title);
    assert.equal(result.decision, 'review', title);
    assert.ok(result.reasons.includes('transactional scope (payments or checkout): at most a review'), title);
  }
  for (const description of [
    'Please implement a payment gateway for my website in HTML and JavaScript, so that customers can pay by card.',
    'We need to fix the billing page of our React web app; it charges customers twice.',
    'A landing page in React with recurring billing for members and a checkout flow built from scratch.',
  ]) {
    assert.equal(central('Website update', description).decision, 'review', description);
  }
  assert.equal(central('Responsive landing page in React', DESCRIPTION).decision, 'top_match', 'no payments at all');
});

test('a central skill outside the profile is a skip; beside an available skill it is a doubt, never a skip', () => {
  assert.equal(decision({ title: 'Python data scraper' }), 'skip');
  assert.equal(decision({ title: 'Rust command line tool', description: 'A command line tool in Rust that renames files. Small and well tested.' }), 'skip');
  assert.equal(decision({ title: 'Unity game with C sharp' }), 'skip');
  const mixed = evaluate(freelancerProject({ title: 'WordPress plugin with a Python script', description: 'A WordPress plugin, plus a small Python script that runs nightly to sync the data with our office system in a simple way.' }));
  assert.equal(mixed.decision, 'review');
  assert.ok(mixed.reasons.some((reason) => reason.startsWith('essential skill outside the profile')));
  const lead = evaluate(freelancerProject({ title: 'Help with my web project', description: 'A React front-end with a Python backend, mostly the Python side, running on the cloud for a few thousand users.' }));
  assert.equal(lead.decision, 'review');
  const leadOnly = evaluate(freelancerProject({ title: 'Help with my project', description: 'Please build the whole thing in Python and Django, with a reporting module and a scheduler for our team of ten people.' }));
  assert.equal(leadOnly.decision, 'skip', 'central skill at the start of the description, nothing available named');
  assert.equal(translateReason('central skill outside the profile: "python" in the title'), 'habilidade central fora do perfil: "python" no título');
});

test('doubts still cap at review: unclear task, tags only, a senior title, a very short deadline, a missing type', () => {
  assert.equal(decision({ title: 'Need help with my thing', description: 'Please help me out this week with something I am working on, thanks a lot in advance.', skills: ['React', 'HTML'] }), 'review');
  assert.equal(decision({ description: 'A one-page site in HTML and CSS, built and ready to test within the next five hours, with a contact form and a map.' }), 'review');
  assert.equal(decision({ title: 'Senior React developer for a landing page' }), 'review');
  assert.equal(decision({ employmentType: 'unknown' }), 'review');
  assert.equal(decision({ sourceMetadata: { language: 'de' } }), 'review');
  assert.equal(veryShortDeadlineHours('Deliver in 3 hours please'), 3);
  assert.equal(veryShortDeadlineHours('We need this within 24 hours'), 24);
  assert.equal(veryShortDeadlineHours('Entrega em 6 horas'), 6);
  for (const calm of ['Delivered in two weeks', 'about 10 hours per week', 'within 30 hours of work', 'in 20 hours a week', 'Ready within 48 hours', 'no deadline']) {
    assert.equal(veryShortDeadlineHours(calm), null, calm);
  }
});

test('the main task must be technical: payroll, stories, chat support and ads are skipped even with a skill tag', () => {
  assert.equal(decision({ title: 'Payroll dashboard web app in React' }), 'top_match', 'a technical deliverable in the title keeps it relevant');
  assert.equal(decision({ title: 'Translation plugin for WordPress' }), 'top_match');
  assert.equal(decision({ title: 'Trading bot for Telegram' }), 'top_match', 'a bot is a technical deliverable, and the brief names strong skills up front');
  assert.equal(decision({ title: 'Google Ads landing page in WordPress' }), 'top_match', 'a strong skill in the title rescues a marketing word');
  assert.equal(decision({ title: 'SEO audit for my bakery' }), 'skip', 'a marketing word in the title needs a strong skill named there');
  const talk = 'I need someone to answer my customers every afternoon and keep a friendly tone with all of them.';
  assert.equal(decision({ title: 'Customer support agent for chat', description: talk }), 'skip');
  assert.equal(decision({ title: 'Virtual assistant for e-mail and calendar', description: talk }), 'skip');
  const disagree = evaluate(freelancerProject({ title: 'Copywriting help', description: 'Build a website in React and HTML with a blog. Copy comes later, and I will supply the photos for it.' }));
  assert.equal(disagree.decision, 'review');
  assert.match(mainCaveat(disagree.reasons)!, /^title names non-technical work/);
  const filler = 'We are a family business that has been around for many years and we enjoy working with people. '.repeat(9);
  assert.equal(evaluate(freelancerProject({ title: 'Help needed', description: `${filler}Also we have a website in HTML.` })).decision, 'review');
});

// ---------- messages ----------
test('the message says a low budget is the main worry on a green alert, without the conversion', () => {
  const cheap = freelancerProject({ title: 'Small landing page in HTML', proposalCount: 68, budget: { currency: 'USD', kind: 'fixed', min: 10, max: 40 } });
  const filter = evaluate(cheap);
  assert.equal(filter.decision, 'shortlist');
  assert.equal(basicAttention(cheap, filter, NOW), LOW_BUDGET_TEXT, 'wins over the crowding note');
  assert.equal(LOW_BUDGET_TEXT, 'Orçamento baixo para o escopo; avalie se compensa pelo portfólio, avaliação ou experiência.');
  const message = formatOpportunityMessage(cheap, filter, { now: NOW });
  assert.ok(message.includes('<b>🟢 OPORTUNIDADE COMPATÍVEL</b>'));
  assert.ok(message.includes(`<b>⚠️ Atenção</b>\n${LOW_BUDGET_TEXT}`));
  assert.ok(!/US\$|floor|piso/.test(message.split('⚠️ Atenção')[1]!), 'no conversion or floor in the message');

  const crowded = freelancerProject({ proposalCount: 100 });
  assert.equal(basicAttention(crowded, evaluate(crowded), NOW), 'Concorrência alta: 100 propostas já enviadas.');
  const swamped = freelancerProject({ proposalCount: 300 });
  assert.equal(basicAttention(swamped, evaluate(swamped), NOW), 'Concorrência muito alta: 300 propostas já enviadas.');
  const top = freelancerProject();
  assert.ok(formatOpportunityMessage(top, evaluate(top), { now: NOW }).includes('<b>🔵 MATCH EXCELENTE</b>'));
  assert.equal(basicAttention(top, evaluate(top), NOW), null, 'nothing to warn about on a clean top match');
});
