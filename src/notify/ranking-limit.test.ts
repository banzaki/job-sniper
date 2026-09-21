import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../config.js';
import type { FilterResult } from '../domain/filter-result.js';
import type { Opportunity } from '../domain/opportunity.js';
import { budgetRank, compareForAlert, competitionTier, publicationDay, strongSignalCount } from '../filter/ranking.js';
import { evaluateOpportunity } from '../filter/opportunity-filter.js';
import { donBrunoProfile } from '../profile/don-bruno.js';
import { OpportunityStore } from '../storage/opportunity-store.js';
import { makeOpportunity, NOW } from '../testing/fixtures.js';
import type { Notifier, SendOptions } from './notifier.js';
import { notifyPending } from './notify-pending.js';
import { SOURCE_LABELS } from './source-labels.js';

const HOUR = 3_600_000;
const quiet = (): void => {};

interface Spec {
  id: string;
  sourceId?: string;
  decision?: FilterResult['decision'];
  strong?: string[];
  proposals?: number | null;
  published?: string | null;
  marketplace?: boolean;
  fetchedAt?: string;
}

/** An opportunity plus the filter result it would have, built directly so each ranking criterion is isolated. */
function make(spec: Spec): { opportunity: Opportunity; filter: FilterResult } {
  const marketplace = spec.marketplace ?? (spec.sourceId === 'freelancer');
  const opportunity = makeOpportunity(spec.id, {
    sourceId: spec.sourceId ?? 'fake',
    title: `Project ${spec.id}`,
    publishedAt: spec.published === undefined ? '2026-05-01T09:00:00.000Z' : spec.published,
    proposalCount: spec.proposals === undefined ? 30 : spec.proposals,
    fetchedAt: spec.fetchedAt ?? NOW.toISOString(),
    ...(marketplace ? { employmentType: 'freelance' as const } : {}),
  });
  const strong = spec.strong ?? ['HTML'];
  return {
    opportunity,
    filter: {
      decision: spec.decision ?? 'shortlist',
      reasons: strong.length > 0 ? [`strong signals: ${strong.join(', ')}`] : ['weak signals: site'],
      matchedKeywords: strong,
      evaluatedAt: NOW.toISOString(),
      ruleVersion: 'basic-v5',
    },
  };
}
const order = (specs: Spec[]): string[] => specs.map(make).sort(compareForAlert).map((entry) => `${entry.opportunity.sourceId}:${entry.opportunity.externalId}`);

// ---------- ranking ----------
test('shortlist comes before review, whatever the other criteria say', () => {
  assert.deepEqual(order([{ id: 'r', decision: 'review', proposals: 0, strong: ['HTML', 'CSS', 'React'] }, { id: 's', decision: 'shortlist', proposals: 200, published: '2026-04-01T00:00:00Z' }]), ['fake:s', 'fake:r']);
});

test('the crowding tier: up to 20, 21-60, 61-150 and more than 150; recency comes before it in the order', () => {
  const tiers = (n: number) => competitionTier(make({ id: 'x', sourceId: 'freelancer', proposals: n }).opportunity);
  assert.deepEqual([0, 20, 21, 60, 61, 150, 151, 400].map(tiers), [0, 0, 1, 1, 2, 2, 3, 3]);
  assert.equal(competitionTier(make({ id: 'x', sourceId: 'freelancer', proposals: null }).opportunity), 1, 'unknown is normal');
  assert.equal(competitionTier(make({ id: 'x', sourceId: '99freelas', proposals: 5, marketplace: false }).opportunity), 0, 'a source with no engagement type is judged by its proposals too');
  assert.equal(competitionTier(make({ id: 'x', sourceId: '99freelas', proposals: 200, marketplace: false }).opportunity), 3);
  assert.deepEqual(
    order([
      { id: 'reduced', sourceId: 'freelancer', proposals: 100, published: '2026-05-01T20:00:00Z' },
      { id: 'normal', sourceId: 'freelancer', proposals: 40 },
      { id: 'high', sourceId: 'freelancer', proposals: 8, published: '2026-04-29T09:00:00Z' },
    ]),
    // Same day for the first two, so fewer proposals decide; the older project comes after (recency outranks the tier).
    ['freelancer:normal', 'freelancer:reduced', 'freelancer:high'],
  );
});

test('then the most recent day first (Brasília calendar day), unknown dates last', () => {
  assert.deepEqual(
    order([
      { id: 'old', published: '2026-04-28T15:00:00Z' },
      { id: 'unknown', published: null },
      { id: 'today', published: '2026-05-01T15:00:00Z' },
      { id: 'yesterday', published: '2026-04-30T15:00:00Z' },
    ]),
    ['fake:today', 'fake:yesterday', 'fake:old', 'fake:unknown'],
  );
  // Same day in Brasília (UTC-3): 02:00Z on the 2nd is still the 1st there.
  assert.equal(publicationDay(make({ id: 'a', published: '2026-05-02T02:00:00Z' }).opportunity), '2026-05-01');
  assert.equal(publicationDay(make({ id: 'b', published: null }).opportunity), '');
});

test('within the same day: fewer proposals, then more strong skills, then the stable id', () => {
  assert.deepEqual(order([{ id: 'one', strong: ['HTML'] }, { id: 'three', strong: ['HTML', 'CSS', 'React'] }, { id: 'two', strong: ['HTML', 'CSS'] }]), ['fake:three', 'fake:two', 'fake:one']);
  assert.deepEqual(order([{ id: 'many', proposals: 80 }, { id: 'few', proposals: 25 }, { id: 'none-known', proposals: null }]), ['fake:few', 'fake:many', 'fake:none-known']);
  assert.deepEqual(order([{ id: 'b' }, { id: 'c' }, { id: 'a' }]), ['fake:a', 'fake:b', 'fake:c'], 'identical criteria: by id');
  assert.deepEqual(order([{ id: '1', sourceId: 'remotive' }, { id: '1', sourceId: 'freelancer' }, { id: '1', sourceId: '99freelas' }]).slice().sort(), ['99freelas:1', 'freelancer:1', 'remotive:1']);
  assert.equal(strongSignalCount(make({ id: 'x', strong: ['HTML', 'CSS'] }).filter), 2);
  assert.equal(strongSignalCount(make({ id: 'x', strong: [] }).filter), 0);
});

test('the order does not depend on the input order', () => {
  const specs: Spec[] = Array.from({ length: 12 }, (_, i) => ({ id: String(i), decision: i % 3 === 0 ? 'review' : 'shortlist', proposals: (i * 37) % 200, strong: ['HTML', 'CSS', 'React'].slice(0, (i % 3) + 1), published: `2026-04-${String(20 + (i % 9)).padStart(2, '0')}T12:00:00Z` }));
  assert.deepEqual(order(specs), order([...specs].reverse()));
});

// ---------- the new filter rules ----------
const project = (over: Partial<Opportunity> = {}): Opportunity =>
  makeOpportunity('9', {
    sourceId: 'freelancer',
    title: 'Responsive landing page in React',
    description: 'A responsive landing page in React, HTML and CSS, delivered in two weeks.',
    category: 'Websites, IT & Software',
    subcategory: null,
    employmentType: 'freelance',
    proposalCount: 30,
    sourceMetadata: { language: 'en' },
    ...over,
  });
const decide = (opportunity: Opportunity) => evaluateOpportunity(opportunity, donBrunoProfile, NOW);

test('competition never removes or caps a compatible project: it is a caveat, and above 150 the lowest priority of its group', () => {
  assert.equal(decide(project({ proposalCount: 60 })).decision, 'shortlist');
  for (const proposals of [61, 150]) {
    const crowded = decide(project({ proposalCount: proposals }));
    assert.equal(crowded.decision, 'shortlist', 'still green');
    assert.ok(crowded.reasons.includes(`crowded project (${proposals} proposals): lowers the ranking`));
  }
  for (const proposals of [151, 400]) {
    const crowded = decide(project({ proposalCount: proposals }));
    assert.equal(crowded.decision, 'shortlist', 'still relevant, not a skip and not yellow');
    assert.ok(crowded.reasons.includes(`very crowded project (${proposals} proposals): lowest priority in its group`));
  }
  assert.equal(decide(project({ proposalCount: null })).decision, 'shortlist', 'unknown is not crowded');
  assert.equal(decide(project({ proposalCount: 400, title: 'x', description: 'no skills at all' })).decision, 'skip', 'an irrelevant project is still a skip');
});

test('a project in a language outside the profile is at most a review; pt, en and unknown are fine', () => {
  const german = decide(project({ sourceMetadata: { language: 'de' } }));
  assert.equal(german.decision, 'review');
  assert.ok(german.reasons.includes('project language "de" is not one of the profile languages'));
  assert.equal(decide(project({ sourceMetadata: { language: 'DE-AT' } })).decision, 'review', 'a regional code is read by its language');
  for (const language of ['pt', 'en', 'PT-BR']) assert.equal(decide(project({ sourceMetadata: { language } })).decision, 'shortlist', language);
  assert.equal(decide(project({ sourceMetadata: {} })).decision, 'shortlist', 'no language given: nothing is assumed');
  assert.equal(decide(project({ sourceMetadata: { language: 'de' }, title: 'x', description: 'no skills at all' })).decision, 'skip', 'the cap never raises a skip');
});

test('99Freelas takes part in the ladder as a freelance source: crowding is a caveat, an open budget never makes a top match', () => {
  const legacy = makeOpportunity('7', {
    title: 'Landing page em HTML e CSS',
    description: 'Preciso de uma landing page responsiva.',
    category: 'Web, Mobile & Software',
    subcategory: 'Desenvolvimento Web',
    proposalCount: 900,
  });
  assert.equal(legacy.employmentType, undefined, 'the source publishes no engagement type');
  const result = decide(legacy);
  assert.equal(result.decision, 'shortlist', 'never skipped or capped for competition');
  assert.ok(result.reasons.includes('very crowded project (900 proposals): lowest priority in its group'));
  assert.ok(!result.reasons.some((reason) => /^employment type/.test(reason)), 'no type is invented for it');
  const calm = decide({ ...legacy, proposalCount: 5, description: 'Preciso de uma landing page responsiva em HTML e CSS para divulgar meu curso online, com formulário de contato, depoimentos e uma seção de perguntas frequentes, entrega em duas semanas.' });
  assert.equal(calm.decision, 'shortlist', 'a budget that is open (unknown) does not block the green, but blocks the blue');
});

// ---------- the global per-run limit ----------
function recorder() {
  const sent: string[] = [];
  const notifier: Notifier = { send: async (text: string, _options: SendOptions = {}) => (sent.push(text), { messageId: `m${sent.length}` }) };
  return { notifier, sent };
}

function seed(specs: Spec[]): OpportunityStore {
  const store = new OpportunityStore(':memory:');
  for (const spec of specs) {
    const { opportunity, filter } = make(spec);
    store.insert(opportunity, filter, '2026-05-01T00:00:00.000Z');
  }
  return store;
}
const run = (store: OpportunityStore, notifier: Notifier, extra: { maxAlerts?: number; dryRun?: boolean } = {}) =>
  notifyPending({ store, notifier, decisions: ['shortlist', 'review'], dryRun: extra.dryRun ?? false, format: { sourceLabels: SOURCE_LABELS, now: NOW }, now: () => NOW, ...(extra.maxAlerts !== undefined ? { maxAlerts: extra.maxAlerts } : {}) });
const titles = (sent: string[]): string[] => sent.map((text) => /Project (\S+?)<\/b>/.exec(text)?.[1] ?? '?');

test('the limit is global: alerts of every source share it, best first, and the rest stay pending and unmarked', async () => {
  const specs: Spec[] = [
    ...Array.from({ length: 6 }, (_, i): Spec => ({ id: `f${i}`, sourceId: 'freelancer', proposals: 10 + i * 30, strong: ['HTML', 'CSS'] })),
    ...Array.from({ length: 6 }, (_, i): Spec => ({ id: `r${i}`, sourceId: 'remotive', decision: i < 2 ? 'shortlist' : 'review', proposals: null, marketplace: false })),
    { id: 'n1', sourceId: '99freelas', decision: 'review', proposals: 3, marketplace: false },
  ];
  const store = seed(specs);
  const { notifier, sent } = recorder();

  const first = await run(store, notifier, { maxAlerts: 5 });
  assert.equal(sent.length, 5, 'five alerts in total, not five per source');
  assert.equal(first.sent, 5);
  assert.equal(first.pending, 13);
  assert.equal(first.heldByLimit, 8);
  const expected = specs.map(make).sort(compareForAlert).slice(0, 5).map((entry) => entry.opportunity.externalId);
  assert.deepEqual(titles(sent), expected, 'the five sent are exactly the five best, in ranking order');
  assert.equal(store.listPendingNotification(['shortlist', 'review']).length, 8, 'the others are still owed');
  for (const key of store.listPendingNotification(['shortlist', 'review'])) assert.equal(store.get(key)!.notifiedAt, null);

  const second = await run(store, notifier, { maxAlerts: 5 });
  assert.equal(second.sent, 5);
  assert.equal(new Set(titles(sent)).size, 10, 'zero resend: ten different alerts after two runs');
  const third = await run(store, notifier, { maxAlerts: 5 });
  assert.equal(third.sent, 3);
  assert.equal(third.heldByLimit, 0);
  assert.equal(new Set(titles(sent)).size, 13);
  assert.equal((await run(store, notifier, { maxAlerts: 5 })).pending, 0);
  assert.equal(sent.length, 13);
});

test('dry-run respects the limit too and writes nothing; without a limit everything is sent', async () => {
  const specs: Spec[] = Array.from({ length: 8 }, (_, i) => ({ id: String(i), proposals: i }));
  const store = seed(specs);
  const dry = recorder();
  const report = await run(store, dry.notifier, { maxAlerts: 3, dryRun: true });
  assert.equal(dry.sent.length, 3);
  assert.equal(report.rendered, 3);
  assert.equal(report.heldByLimit, 5);
  assert.equal(store.listPendingNotification(['shortlist', 'review']).length, 8, 'nothing was marked');

  const all = recorder();
  assert.equal((await run(store, all.notifier)).sent, 8);
  assert.equal(all.sent.length, 8);
});

test('stale data does not use a slot, and a failed send does', async () => {
  const stale = new Date(NOW.getTime() - 30 * HOUR).toISOString();
  const store = seed([{ id: 'old1', sourceId: 'freelancer', fetchedAt: stale }, { id: 'old2', sourceId: 'freelancer', fetchedAt: stale }, { id: 'a' }, { id: 'b' }, { id: 'c' }]);
  const { notifier, sent } = recorder();
  const report = await notifyPending({ store, notifier, decisions: ['shortlist', 'review'], dryRun: false, format: { now: NOW }, maxAgeHoursBySource: { freelancer: 24 }, maxAlerts: 2, now: () => NOW });
  assert.equal(report.staleWithheld, 2);
  assert.equal(sent.length, 2, 'the two fresh ones were sent');
  assert.equal(report.heldByLimit, 1);

  const flaky = seed([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
  let calls = 0;
  const failing: Notifier = { send: async () => { calls += 1; if (calls === 1) throw new Error('boom'); return { messageId: 'x' }; } };
  const failed = await run(flaky, failing, { maxAlerts: 2 });
  assert.equal(failed.failures.length, 1);
  assert.equal(calls, 2, 'a failed attempt used one of the two slots');
  assert.equal(failed.sent, 1);
  assert.equal(flaky.listPendingNotification(['shortlist', 'review']).length, 2, 'the failed one and the held one are still owed');
});

test('a very crowded Freelancer project stays available as a review, but is owed after everything else', () => {
  const store = new OpportunityStore(':memory:');
  const crowded = project({ externalId: '11', proposalCount: 300 });
  const normal = project({ externalId: '12', proposalCount: 40, publishedAt: '2026-04-01T09:00:00.000Z' });
  store.insert(crowded, decide(crowded), NOW.toISOString());
  store.insert(normal, decide(normal), NOW.toISOString());
  assert.equal(store.count(), 2);
  const owed = store.listPendingNotification(['shortlist', 'review']);
  assert.equal(owed.length, 2, 'it is not dropped');
  const ranked = owed.map((key) => store.get(key)!).sort(compareForAlert).map((entry) => entry.opportunity.externalId);
  assert.deepEqual(ranked, ['12', '11'], 'even though it is newer, it goes last');
});

const CROSSES = 'fixed budget range of about US$ 30–250 crosses the US$ 50 floor';
const LOW = 'fixed budget of about US$ 40 is below the US$ 50 floor';
const NO_RATE = 'budget currency "INR" has no fresh USD conversion: not a top match';
const ranked = (entries: { opportunity: Opportunity; filter: FilterResult }[]): string[] => [...entries].sort(compareForAlert).map((entry) => entry.opportunity.externalId);
const withReasons = (id: string, decision: FilterResult['decision'], extra: string[] = [], over: Partial<Spec> = {}) => {
  const entry = make({ id, sourceId: 'freelancer', decision, ...over });
  entry.filter.reasons.push(...extra);
  return entry;
};

test('the global order is top match, then shortlist, then review, whatever the other criteria say', () => {
  const top = withReasons('top', 'top_match', [], { proposals: 60, published: '2026-04-01T00:00:00Z' });
  const green = withReasons('green', 'shortlist', [], { proposals: 5, published: '2026-05-01T12:00:00Z', strong: ['HTML', 'CSS', 'React'] });
  const yellow = withReasons('yellow', 'review', [], { proposals: 0, published: '2026-05-01T12:00:00Z', strong: ['HTML', 'CSS', 'React'] });
  assert.deepEqual(ranked([yellow, green, top]), ['top', 'green', 'yellow']);
});

test('inside a group: not very crowded, a clear main task, recency, fewer caveats, budget, fewer proposals, strong skills, id', () => {
  // 1. more than 150 proposals goes last of its own group, however new and cheap-free it is.
  assert.deepEqual(ranked([withReasons('swamped', 'review', [], { proposals: 400, published: '2026-05-01T12:00:00Z' }), withReasons('old', 'review', [], { proposals: 40, published: '2026-04-01T12:00:00Z' })]), ['old', 'swamped']);
  // 2. a clearly relevant main task before one with a doubt, even when the doubtful one is newer.
  const doubt = withReasons('doubt', 'review', ['technical deliverable is not clear in the title or the start of the description'], { published: '2026-05-01T12:00:00Z' });
  const clear = withReasons('clear', 'review', [], { published: '2026-04-20T12:00:00Z' });
  assert.deepEqual(ranked([doubt, clear]), ['clear', 'doubt']);
  // 3. the most recent day first.
  assert.deepEqual(ranked([withReasons('a-old', 'review', [], { published: '2026-04-20T12:00:00Z' }), withReasons('z-new', 'review', [], { published: '2026-05-01T12:00:00Z' })]), ['z-new', 'a-old']);
  // 4. fewer caveats first (same day).
  const two = withReasons('two', 'shortlist', [CROSSES, 'crowded project (80 proposals): lowers the ranking'], { proposals: 80 });
  const one = withReasons('one', 'shortlist', ['crowded project (80 proposals): lowers the ranking'], { proposals: 80 });
  const none = withReasons('none', 'shortlist', [], { proposals: 80 });
  assert.deepEqual(ranked([two, one, none]), ['none', 'one', 'two']);
  // 5. the better budget (same day, same caveat count): reaches < crosses < no fresh conversion < below the floor.
  const reaches = withReasons('reaches', 'shortlist');
  const noRate = withReasons('no-rate', 'shortlist', [NO_RATE]);
  const low = withReasons('low', 'shortlist', [LOW]);
  assert.deepEqual(ranked([low, noRate, reaches]), ['reaches', 'no-rate', 'low'], 'a missing conversion is not a caveat, a low budget is');
  assert.deepEqual([budgetRank(reaches.filter), budgetRank(noRate.filter), budgetRank(withReasons('c', 'shortlist', [CROSSES]).filter), budgetRank(low.filter)], [0, 2, 1, 3]);
  // 6. fewer proposals, 7. more strong skills, 8. the id.
  assert.deepEqual(ranked([withReasons('many', 'review', [], { proposals: 50 }), withReasons('few', 'review', [], { proposals: 10 })]), ['few', 'many']);
  assert.deepEqual(ranked([withReasons('one-skill', 'review', [], { strong: ['HTML'] }), withReasons('two-skills', 'review', [], { strong: ['HTML', 'CSS'] })]), ['two-skills', 'one-skill']);
  assert.deepEqual(ranked([withReasons('b', 'review'), withReasons('a', 'review')]), ['a', 'b']);
});

test('the order of the same criteria does not depend on the input order, with top match in the mix', () => {
  const specs = Array.from({ length: 16 }, (_, i) => withReasons(String(i), (['top_match', 'shortlist', 'review'] as const)[i % 3]!, i % 4 === 0 ? [LOW] : [], { proposals: (i * 53) % 260, published: `2026-04-${String(20 + (i % 9)).padStart(2, '0')}T12:00:00Z`, strong: ['HTML', 'CSS', 'React'].slice(0, (i % 3) + 1) }));
  assert.deepEqual(ranked(specs), ranked([...specs].reverse()));
});

// ---------- configuration ----------
test('MAX_TELEGRAM_ALERTS_PER_RUN defaults to 5 and must be a positive integer', () => {
  assert.equal(loadConfig({}, quiet).maxTelegramAlertsPerRun, 5);
  assert.equal(loadConfig({ MAX_TELEGRAM_ALERTS_PER_RUN: ' 12 ' }, quiet).maxTelegramAlertsPerRun, 12);
  assert.equal(loadConfig({ MAX_TELEGRAM_ALERTS_PER_RUN: '' }, quiet).maxTelegramAlertsPerRun, 5);
  for (const bad of ['0', '-1', 'abc', '2.5']) {
    assert.throws(() => loadConfig({ MAX_TELEGRAM_ALERTS_PER_RUN: bad }, quiet), /MAX_TELEGRAM_ALERTS_PER_RUN must be a positive integer/, bad);
  }
});
