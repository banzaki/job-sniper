import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Opportunity } from '../domain/opportunity.js';
import { donBrunoProfile } from '../profile/don-bruno.js';
import { translateReason } from '../notify/translate-reasons.js';
import { makeOpportunity, NOW } from '../testing/fixtures.js';
import { budgetInUsd } from './budget.js';
import { mainCaveat } from './engagement-policy.js';
import { evaluateOpportunity } from './opportunity-filter.js';

// basic-v6: the main task must be technical, the budget must be worth it, and a crowded project is never "good".
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

test('a fixed price or hourly rate under the USD floor is skipped; the original budget is only judged, never changed', () => {
  const fixed = evaluate(freelancerProject({ budget: { currency: 'USD', kind: 'fixed', min: 10, max: 40 } }));
  assert.equal(fixed.decision, 'skip');
  assert.equal(fixed.reasons[0], 'fixed budget of about US$40 is below the US$50 floor');
  assert.equal(evaluate(freelancerProject({ budget: { currency: 'USD', kind: 'fixed', min: 50, max: 50 } })).decision, 'shortlist', 'the floor itself is allowed');
  assert.equal(evaluate(freelancerProject({ budget: { currency: 'USD', kind: 'fixed', min: 50, max: 200 } })).decision, 'shortlist', 'a bottom that reaches the floor passes');

  const hourly = evaluate(freelancerProject({ budget: { currency: 'USD', kind: 'hourly', min: 2, max: 7 } }));
  assert.equal(hourly.decision, 'skip');
  assert.equal(hourly.reasons[0], 'hourly rate of about US$7/h is below the US$8/h floor');
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

  assert.equal(evaluate(freelancerProject({ budget: { currency: 'USD', kind: 'fixed', min: 10, max: 49 } })).decision, 'skip', 'a top under the floor is still skipped');
  assert.equal(evaluate(freelancerProject({ budget: { currency: 'USD', kind: 'fixed', min: 10, max: 50 } })).decision, 'review', 'a top exactly at the floor crosses it');
  assert.equal(evaluate(freelancerProject({ budget: { currency: 'USD', kind: 'hourly', min: 8, max: 20 } })).decision, 'shortlist', 'a bottom at the floor passes');
  // A missing bound is open, not zero and not infinite: it cannot skip, and it cannot prove the floor is reached.
  assert.equal(evaluate(freelancerProject({ budget: { currency: 'USD', kind: 'fixed', min: 10, max: null } })).decision, 'review');
  assert.equal(evaluate(freelancerProject({ budget: { currency: 'USD', kind: 'fixed', min: 60, max: null } })).decision, 'shortlist');
  assert.equal(evaluate(freelancerProject({ budget: { currency: 'USD', kind: 'fixed', min: null, max: 90 } })).decision, 'review');
  assert.equal(evaluate(freelancerProject({ budget: { currency: 'USD', kind: 'fixed', min: null, max: 20 } })).decision, 'skip');
});

test('another currency is judged by the rate the source published; without one it is at most a review, with no value invented', () => {
  const inr = (min: number, max: number, rate?: number) =>
    freelancerProject({ budget: { currency: 'INR', kind: 'fixed', min, max }, sourceMetadata: { language: 'en', ...(rate === undefined ? {} : { exchangeRateToUsd: rate }) } });

  const cheap = evaluate(inr(600, 1500, 0.010439));
  assert.equal(cheap.decision, 'skip');
  assert.equal(cheap.reasons[0], 'fixed budget of about US$16 is below the US$50 floor', '1500 INR x 0.010439');
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

test('competition: up to 60 proposals may be shortlisted, 61 to 150 are at most a review, more than 150 are skipped', () => {
  assert.equal(evaluate(freelancerProject({ proposalCount: 60 })).decision, 'shortlist');
  for (const proposals of [61, 100, 150]) {
    const crowded = evaluate(freelancerProject({ proposalCount: proposals }));
    assert.equal(crowded.decision, 'review', String(proposals));
    assert.ok(crowded.reasons.includes(`crowded project (${proposals} proposals): at most a review`));
  }
  assert.equal(evaluate(freelancerProject({ proposalCount: 151 })).decision, 'skip');
  assert.equal(evaluate(freelancerProject({ proposalCount: null })).decision, 'shortlist', 'unknown is not crowded');
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
