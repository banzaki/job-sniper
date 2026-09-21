import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Opportunity } from '../domain/opportunity.js';
import { donBrunoProfile } from '../profile/don-bruno.js';
import { basicAttention, LOW_BUDGET_TEXT } from '../notify/blocks.js';
import { formatOpportunityMessage } from '../notify/format-message.js';
import { translateReason } from '../notify/translate-reasons.js';
import { makeOpportunity, NOW } from '../testing/fixtures.js';
import { budgetInUsd } from './budget.js';
import { mainCaveat } from './engagement-policy.js';
import { evaluateOpportunity } from './opportunity-filter.js';
import { budgetRank } from './ranking.js';
import { veryShortDeadlineHours } from './scope-risk.js';

// basic-v7: the main task must be technical; budget, competition, deadline and scope only cap a relevant project at review.
const freelancerProject = (over: Partial<Opportunity> = {}): Opportunity =>
  makeOpportunity('1', {
    sourceId: 'freelancer',
    title: 'Responsive landing page in React',
    description: 'A responsive landing page in React, HTML and CSS, delivered in two weeks.',
    category: 'Websites, IT & Software',
    subcategory: null,
    employmentType: 'freelance',
    proposalCount: 30,
    budget: { currency: 'USD', kind: 'fixed', min: 200, max: 500 },
    sourceMetadata: { language: 'en' },
    ...over,
  });
const evaluate = (opportunity: Opportunity) => evaluateOpportunity(opportunity, donBrunoProfile, NOW);

test('a payroll or story-writing main task is skipped even when the tags and the text mention HTML, React or WordPress', () => {
  const payroll = evaluate(
    freelancerProject({
      title: 'Environmental Admin & Payroll Coordinator',
      description:
        'I run a habitat-restoration company and need an organised hand. The heartbeat of the job is keeping our timecards and payroll straight in QuickBooks and ADP. Occasionally update the pages (HTML, WordPress).',
      skills: ['PHP', 'HTML', 'Payroll', 'Data Entry'],
    }),
  );
  assert.equal(payroll.decision, 'skip');
  assert.match(payroll.reasons[0]!, /^main task is not technical: "payroll" in the title/);

  const story = evaluate(
    freelancerProject({
      title: 'Text-Based Children’s Story Editor',
      description: 'I need someone to polish my children’s stories, fix the grammar and keep a warm voice. Skills: JavaScript, React.',
      skills: ['JavaScript', 'Editing', 'Ghostwriting'],
    }),
  );
  assert.equal(story.decision, 'skip');
  assert.match(story.reasons[0]!, /^main task is not technical: "story"/);
});

test('a technical deliverable in the title keeps a project relevant, even beside a non-technical word', () => {
  for (const title of ['Payroll dashboard web app in React', 'Translation plugin for WordPress', 'Trading bot for Telegram', 'Sales dashboard development']) {
    assert.equal(evaluate(freelancerProject({ title })).decision, 'shortlist', title);
  }
});

test('a non-technical title over a technical start of the description, or an unclear task, is at most a review', () => {
  const disagree = evaluate(freelancerProject({ title: 'Copywriting help', description: 'Build a website in React and HTML with a blog. Copy comes later.' }));
  assert.equal(disagree.decision, 'review');
  assert.match(disagree.reasons[0]!, /^title names non-technical work \("copywriting"\)/);
  assert.match(mainCaveat(disagree.reasons)!, /^title names non-technical work/);

  const unclear = evaluate(freelancerProject({ title: 'Need help with my thing', description: 'Please help me out this week with something I am working on.', skills: ['React', 'HTML'] }));
  assert.equal(unclear.decision, 'review');
  assert.ok(unclear.reasons.includes('technical deliverable is not clear in the title or the start of the description'));
});

test('a technical deliverable that only appears deep in the description does not count as the main task', () => {
  const filler = 'We are a family business that has been around for many years and we enjoy working with people. '.repeat(6);
  const deep = evaluate(freelancerProject({ title: 'Help needed', description: `${filler}Also we have a website in HTML.` }));
  assert.equal(deep.decision, 'review');
  assert.ok(deep.reasons.includes('technical deliverable is not clear in the title or the start of the description'));
});

test('a fixed price or hourly rate under the USD floor is at most a review, never a skip; the original budget is never changed', () => {
  const fixed = evaluate(freelancerProject({ budget: { currency: 'USD', kind: 'fixed', min: 10, max: 40 } }));
  assert.equal(fixed.decision, 'review', 'a relevant project stays available');
  assert.ok(fixed.reasons.includes('fixed budget of about US$40 is below the US$50 floor for a shortlist'));
  assert.match(mainCaveat(fixed.reasons)!, /below the US\$50 floor for a shortlist$/);
  assert.equal(evaluate(freelancerProject({ budget: { currency: 'USD', kind: 'fixed', min: 50, max: 50 } })).decision, 'shortlist', 'the floor itself is allowed');
  assert.equal(evaluate(freelancerProject({ budget: { currency: 'USD', kind: 'fixed', min: 50, max: 200 } })).decision, 'shortlist', 'a bottom that reaches the floor passes');

  const hourly = evaluate(freelancerProject({ budget: { currency: 'USD', kind: 'hourly', min: 2, max: 7 } }));
  assert.equal(hourly.decision, 'review');
  assert.ok(hourly.reasons.includes('hourly rate of about US$7/h is below the US$8/h floor for a shortlist'));
  assert.equal(evaluate(freelancerProject({ budget: { currency: 'USD', kind: 'hourly', min: 8, max: 8 } })).decision, 'shortlist');

  const opportunity = freelancerProject({ budget: { currency: 'USD', kind: 'fixed', min: 10, max: 40 } });
  evaluate(opportunity);
  assert.deepEqual(opportunity.budget, { currency: 'USD', kind: 'fixed', min: 10, max: 40 });
});

test('a range that crosses the floor (bottom under it, top at or over it) is at most a review, never a shortlist', () => {
  const hourly = evaluate(freelancerProject({ budget: { currency: 'INR', kind: 'hourly', min: 750, max: 1250 }, sourceMetadata: { language: 'en', exchangeRateToUsd: 0.010439 } }));
  assert.equal(hourly.decision, 'review', 'about US$7.8 to US$13 an hour');
  assert.ok(hourly.reasons.includes('hourly budget range of about US$7.8 to 13/h crosses the US$8/h floor: at most a review'));
  assert.match(mainCaveat(hourly.reasons)!, /^hourly budget range of about/);

  const fixed = evaluate(freelancerProject({ budget: { currency: 'USD', kind: 'fixed', min: 30, max: 250 } }));
  assert.equal(fixed.decision, 'review');
  assert.ok(fixed.reasons.includes('fixed budget range of about US$30 to 250 crosses the US$50 floor: at most a review'));
  assert.equal(translateReason(hourly.reasons.find((reason) => reason.includes('budget range'))!), 'faixa de orçamento (cerca de US$7.8 to 13/h) atravessa o mínimo de US$8/h: no máximo revisar');

  assert.equal(evaluate(freelancerProject({ budget: { currency: 'USD', kind: 'fixed', min: 10, max: 49 } })).decision, 'review', 'a top under the floor is a review');
  assert.equal(evaluate(freelancerProject({ budget: { currency: 'USD', kind: 'fixed', min: 10, max: 50 } })).decision, 'review', 'a top exactly at the floor crosses it');
  assert.equal(evaluate(freelancerProject({ budget: { currency: 'USD', kind: 'hourly', min: 8, max: 20 } })).decision, 'shortlist', 'a bottom at the floor passes');
  // A missing bound is open, not zero and not infinite: it cannot prove the floor is reached.
  assert.equal(evaluate(freelancerProject({ budget: { currency: 'USD', kind: 'fixed', min: 10, max: null } })).decision, 'review');
  assert.equal(evaluate(freelancerProject({ budget: { currency: 'USD', kind: 'fixed', min: 60, max: null } })).decision, 'shortlist');
  assert.equal(evaluate(freelancerProject({ budget: { currency: 'USD', kind: 'fixed', min: null, max: 90 } })).decision, 'review');
  assert.equal(evaluate(freelancerProject({ budget: { currency: 'USD', kind: 'fixed', min: null, max: 20 } })).decision, 'review');
});

test('another currency is judged by the rate the source published; without one it is at most a review, with no value invented', () => {
  const inr = (min: number, max: number, rate?: number) =>
    freelancerProject({ budget: { currency: 'INR', kind: 'fixed', min, max }, sourceMetadata: { language: 'en', ...(rate === undefined ? {} : { exchangeRateToUsd: rate }) } });

  const cheap = evaluate(inr(600, 1500, 0.010439));
  assert.equal(cheap.decision, 'review');
  assert.ok(cheap.reasons.includes('fixed budget of about US$16 is below the US$50 floor for a shortlist'), '1500 INR x 0.010439');
  assert.equal(evaluate(inr(12_500, 37_500, 0.010439)).decision, 'shortlist', 'about US$392 at the top of the range');

  const unknownRate = evaluate(inr(12_500, 37_500));
  assert.equal(unknownRate.decision, 'review');
  assert.ok(unknownRate.reasons.includes('budget currency "INR" has no reliable USD conversion'));
  assert.equal(mainCaveat(unknownRate.reasons), 'budget currency "INR" has no reliable USD conversion');
  for (const bad of [0, -1, Number.NaN]) assert.equal(evaluate(inr(12_500, 37_500, bad)).decision, 'review', `rate ${bad} is not reliable`);

  const noCurrency = evaluate(freelancerProject({ budget: { currency: '', kind: 'fixed', min: 1000, max: 2000 } }));
  assert.equal(noCurrency.decision, 'review');
  assert.ok(noCurrency.reasons.includes('budget currency not stated: no reliable USD conversion'));
});

test('the internal USD equivalent uses the published rate and is unavailable without one', () => {
  const eur = freelancerProject({ budget: { currency: 'EUR', kind: 'hourly', min: 10, max: 20 }, sourceMetadata: { exchangeRateToUsd: 1.5 } });
  assert.deepEqual(budgetInUsd(eur), { status: 'ok', kind: 'hourly', minUsd: 15, maxUsd: 30 });
  assert.deepEqual(budgetInUsd(freelancerProject({ budget: { currency: 'usd', kind: 'fixed', min: null, max: 90 } })), { status: 'ok', kind: 'fixed', minUsd: null, maxUsd: 90 });
  assert.deepEqual(budgetInUsd(freelancerProject({ budget: { currency: 'EUR', kind: 'fixed', min: 1, max: 2 } })), { status: 'unconvertible', currency: 'EUR' });
  assert.deepEqual(budgetInUsd(freelancerProject({ budget: null })), { status: 'none' });
});

test('a missing or open budget is not judged at all', () => {
  assert.equal(evaluate(freelancerProject({ budget: null })).decision, 'shortlist');
  assert.equal(evaluate(freelancerProject({ budget: { currency: 'INR', kind: 'unknown', min: 100, max: 200 } })).decision, 'shortlist');
  assert.equal(evaluate(freelancerProject({ budget: { currency: 'USD', kind: 'open', min: null, max: null } })).decision, 'shortlist');
});

test('competition: up to 60 proposals may be shortlisted, more than 60 is at most a review, and never a skip by itself', () => {
  assert.equal(evaluate(freelancerProject({ proposalCount: 60 })).decision, 'shortlist');
  for (const proposals of [61, 100, 150]) {
    const crowded = evaluate(freelancerProject({ proposalCount: proposals }));
    assert.equal(crowded.decision, 'review', String(proposals));
    assert.ok(crowded.reasons.includes(`crowded project (${proposals} proposals): at most a review`));
  }
  const swamped = evaluate(freelancerProject({ proposalCount: 391 }));
  assert.equal(swamped.decision, 'review', 'still relevant');
  assert.ok(swamped.reasons.includes('very crowded project (391 proposals): at most a review, lowest priority'));
  assert.equal(evaluate(freelancerProject({ proposalCount: null })).decision, 'shortlist', 'unknown is not crowded');
});

test('a very short deadline or a transactional scope is at most a review, never a skip by itself', () => {
  const rushed = evaluate(freelancerProject({ description: 'A one-page site in HTML and CSS, built and ready to test within the next five hours.' }));
  assert.equal(rushed.decision, 'review');
  assert.ok(rushed.reasons.includes('very short deadline (about 5 hours): at most a review'));
  assert.equal(veryShortDeadlineHours('Deliver in 3 hours please'), 3);
  assert.equal(veryShortDeadlineHours('We need this within 24 hours'), 24);
  assert.equal(veryShortDeadlineHours('Entrega em 6 horas'), 6);
  assert.equal(veryShortDeadlineHours('a 12 hour turnaround'), 12);
  for (const calm of ['Delivered in two weeks', 'about 10 hours per week', 'within 30 hours of work', 'in 20 hours a week', 'Ready within 48 hours', 'no deadline']) {
    assert.equal(veryShortDeadlineHours(calm), null, calm);
  }

  const payments = evaluate(freelancerProject({ description: 'A landing page in HTML and CSS where visitors pay with Stripe or PayPal at checkout.' }));
  assert.equal(payments.decision, 'review');
  assert.ok(payments.reasons.includes('transactional scope (payments or checkout): at most a review'));
  assert.equal(evaluate(freelancerProject({ description: 'A plain landing page in HTML and CSS with a contact form.' })).decision, 'shortlist');
  // Their reasons read as Portuguese, and neither is the "main" message of a plain low budget.
  assert.equal(translateReason('very short deadline (about 5 hours): at most a review'), 'prazo muito curto (cerca de 5 horas): no máximo revisar');
  assert.equal(translateReason('transactional scope (payments or checkout): at most a review'), 'escopo transacional (pagamentos ou checkout): no máximo revisar');
});

test('Rapid Event Ticketing Landing Page: a real technical opportunity, so a review and never a skip', () => {
  const ticketing = evaluate(
    freelancerProject({
      title: 'Rapid Event Ticketing Landing Page',
      description:
        'I need a fully-functional, one-page ticketing solution built and ready to test within the next five hours. It must include the front-end layout and the checkout flow: visitors choose a quantity, apply a discount code, pay securely (Stripe or PayPal) and get a confirmation. HTML, CSS and JavaScript.',
      proposalCount: 68,
      budget: { currency: 'USD', kind: 'fixed', min: 8, max: 20 },
    }),
  );
  assert.equal(ticketing.decision, 'review');
  for (const reason of [
    'fixed budget of about US$20 is below the US$50 floor for a shortlist',
    'crowded project (68 proposals): at most a review',
    'very short deadline (about 5 hours): at most a review',
    'transactional scope (payments or checkout): at most a review',
  ]) assert.ok(ticketing.reasons.includes(reason), reason);
  assert.equal(budgetRank(ticketing), 3);
});

test('the new rules leave sources without an engagement type alone', () => {
  const legacy = makeOpportunity('7', {
    title: 'Folha de pagamento e landing page',
    description: 'Preciso de uma landing page em HTML e CSS.',
    proposalCount: 100,
    budget: { currency: 'BRL', kind: 'fixed', min: 5, max: 10 },
  });
  assert.equal(legacy.employmentType, undefined);
  assert.equal(evaluate(legacy).decision, 'shortlist');
});

test('the alert says a low budget is the main worry, without showing the conversion', () => {
  const lowBudget = freelancerProject({ title: 'Small landing page in HTML', proposalCount: 68, budget: { currency: 'USD', kind: 'fixed', min: 10, max: 40 } });
  const filter = evaluate(lowBudget);
  assert.equal(filter.decision, 'review');
  assert.equal(basicAttention(lowBudget, filter, NOW), LOW_BUDGET_TEXT, 'wins over the crowding note');
  assert.equal(LOW_BUDGET_TEXT, 'Orçamento baixo para o escopo; avalie se compensa pelo portfólio, avaliação ou experiência.');
  const message = formatOpportunityMessage(lowBudget, filter, { now: NOW });
  assert.ok(message.includes(`<b>⚠️ Atenção</b>\n${LOW_BUDGET_TEXT}`));
  assert.ok(!/US\$|floor|mínimo de/.test(message.split('⚠️ Atenção')[1]!), 'no conversion or floor in the message');
  assert.ok(message.includes('<b>🟡 VALE REVISAR</b>'));

  // Without a low budget, crowding is the note, and a very crowded project says so.
  const crowded = freelancerProject({ proposalCount: 100 });
  assert.equal(basicAttention(crowded, evaluate(crowded), NOW), 'Concorrência alta: 100 propostas já enviadas.');
  const swamped = freelancerProject({ proposalCount: 300 });
  assert.equal(basicAttention(swamped, evaluate(swamped), NOW), 'Concorrência muito alta: 300 propostas já enviadas.');
});
