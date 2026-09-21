import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Opportunity } from '../domain/opportunity.js';
import { translateReason } from '../notify/translate-reasons.js';
import { reevaluateOutdated } from '../pipeline/reevaluate.js';
import { donBrunoProfile } from '../profile/don-bruno.js';
import { OpportunityStore } from '../storage/opportunity-store.js';
import { makeOpportunity, NOW } from '../testing/fixtures.js';
import { fabricatedEngagement } from './fabricated-engagement.js';
import { evaluateOpportunity } from './opportunity-filter.js';

const vocabulary = donBrunoProfile.fabricatedEngagement;
const find = (title: string, description: string) => fabricatedEngagement(title, description, vocabulary);

/** The Web Banner Ad Automation brief as it was posted (abridged only in its deliverables). */
const BANNER =
  'I need a web-based service that can automatically load and “watch” about 1,000 banner ads every day and record each impression. The workflow should run unattended: spin up the browsing session, cycle through the banners, fire the impression pixel, and store a log so I can verify the exact count at any time.\n\nThe core must run in a browser environment (headless Chrome, Playwright, or a similar tool is fine) and sit behind rotating proxies or another technique that keeps the traffic pattern looking natural. A lightweight dashboard on the same web stack will let me see the daily total, export the log, and reset counters when needed.\n\nBecause ad impressions are the only metric I care about, the system just has to record the timestamp, banner ID or URL, and a unique session reference for each hit; no click-through or engagement stats are required. Please build it so the daily target of 1,000 impressions is configurable, making future scaling straightforward.';

const project = (over: Partial<Opportunity> = {}): Opportunity =>
  makeOpportunity('1', { sourceId: 'freelancer', category: 'Websites, IT & Software', subcategory: null, employmentType: 'freelance', proposalCount: 26, budget: { currency: 'USD', kind: 'fixed', min: 300, max: 800 }, sourceMetadata: { language: 'en' }, ...over });
const run = (opportunity: Opportunity) => evaluateOpportunity(opportunity, donBrunoProfile, NOW);

test('Web Banner Ad Automation: automatically loading and watching banner ads to register impressions, hidden behind rotating proxies, is a skip', () => {
  assert.equal(find('Web Banner Ad Automation', BANNER), 'impressions');
  const result = run(project({ title: 'Web Banner Ad Automation', description: BANNER, skills: ['PHP', 'JavaScript', 'HTML', 'Node.js', 'API', 'Automation'] }));
  assert.equal(result.decision, 'skip');
  assert.equal(result.reasons[0], 'prohibited or suspicious activity: the central goal is to fabricate views, clicks or impressions artificially');
  assert.equal(translateReason(result.reasons[0]!), 'atividade proibida ou suspeita: o objetivo central é fabricar visualizações, cliques ou impressões artificialmente');
});

test('it is the goal that counts, not the title, the order of the sentences or an id: the same request under another title is a skip too', () => {
  const shuffled = BANNER.split('\n\n').reverse().join('\n\n');
  for (const title of ['Traffic helper', 'Small automation for my website', 'Node.js worker']) {
    assert.equal(run(project({ title, description: shuffled })).decision, 'skip', title);
  }
});

test('other ways to ask for fabricated views, clicks or engagement are skipped, in English and Portuguese', () => {
  const skipped: [string, string][] = [
    ['Video helper', 'I need a bot that automatically opens my YouTube videos from many IPs to boost the view count.'],
    ['Ads project', 'We want to generate fake clicks on our Google Ads campaign so the numbers look better.'],
    ['Growth script', 'A script to inflate our Instagram followers using bot accounts, running on a schedule.'],
    ['Robô de cliques', 'Preciso de um robô que clique automaticamente nos meus anúncios para gerar cliques todos os dias.'],
    ['Click farm', 'Set up a click farm with rotating proxies so our banner ads register more clicks.'],
    ['Traffic bot', 'A traffic bot that loads my landing page thousands of times a day behind residential proxies so that the traffic looks natural.'],
  ];
  for (const [title, description] of skipped) {
    assert.notEqual(find(title, description), null, `${title}: ${description.slice(0, 40)}`);
    assert.equal(run(project({ title, description })).decision, 'skip', title);
  }
});

test('ordinary ad, tracking and automation work is not touched: an isolated word is not a goal', () => {
  const fine: [string, string][] = [
    ['Impression tracking', 'Implement an impression tracking pixel for our ad platform and a dashboard of daily impressions and clicks per campaign.'],
    ['Ad verification tool', 'Build a script that automatically loads each banner in headless Chrome to verify it renders correctly, and takes a screenshot of each one.'],
    ['Ad server reports', 'Automatically record the impressions and clicks from our own ad server logs into a weekly report for the marketing team.'],
    ['Load test', 'A load-testing script that visits the checkout page 1,000 times a day to measure the response time of our server.'],
    ['Analytics dashboard', 'A dashboard with page views and traffic by source, plus automated weekly e-mail reports for the team.'],
    ['Grow my site', 'Help me increase traffic to my website with better SEO and content, and report the views every month.'],
    ['UI test bot', 'A bot that automatically clicks through the banner component in our regression tests and reports failures.'],
    ['Video player', 'Build a video player in HTML and JavaScript that counts views and watch time for our own videos, with a report.'],
  ];
  for (const [title, description] of fine) assert.equal(find(title, description), null, title);
  const landing = run(project({ title: 'HTML and CSS landing page', description: 'A landing page in HTML and CSS for my small business, with a hero, services, contact form and a map. Design is ready and I will send the texts and the photos for it.' }));
  assert.notEqual(landing.decision, 'skip');
});

test('a profile without this vocabulary judges nothing', () => {
  assert.equal(fabricatedEngagement('Web Banner Ad Automation', BANNER, undefined), null);
});

test('a row already delivered keeps its history: re-evaluating it to skip changes only the decision, never notified_at, and it is no longer owed', () => {
  const store = new OpportunityStore(':memory:');
  const banner = project({ title: 'Web Banner Ad Automation', description: BANNER, skills: ['HTML', 'API'] });
  store.insert(banner, { decision: 'review', reasons: ['strong signals: HTML'], matchedKeywords: ['HTML'], evaluatedAt: '2026-09-21T19:55:00.000Z', ruleVersion: 'basic-v9' }, '2026-09-21T19:55:00.000Z');
  const key = { sourceId: 'freelancer', externalId: '1' };
  store.markNotified(key, '2026-09-21T20:06:37.035Z');
  const before = store.get(key)!;

  const report = reevaluateOutdated(store, donBrunoProfile, NOW);
  assert.equal(report.reevaluated, 1);
  const after = store.get(key)!;
  assert.equal(after.filter.decision, 'skip');
  assert.equal(after.notifiedAt, '2026-09-21T20:06:37.035Z', 'the historical delivery flag is untouched');
  assert.equal(after.firstSeenAt, before.firstSeenAt);
  assert.deepEqual(after.opportunity, before.opportunity);
  assert.deepEqual(store.listPendingNotification(['top_match', 'shortlist', 'review']), []);
});
