import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../../config.js';
import { collectSources } from '../../pipeline/collect-sources.js';
import { runPipeline } from '../../pipeline/run-pipeline.js';
import { donBrunoProfile } from '../../profile/don-bruno.js';
import { OpportunityStore } from '../../storage/opportunity-store.js';
import { createSourceRuns } from '../create-sources.js';
import { SourceAuthError, SourceBlockedError, SourceNotFoundError, SourceResponseError } from '../source-errors.js';
import { FreelancerClient, type FreelancerApi } from './freelancer-client.js';
import { normalizeBudget, normalizeStatus, parseSearchResult, plainText, projectUrl, toOpportunity, toSummary } from './freelancer-parser.js';
import { FreelancerSource } from './freelancer-source.js';

const NOW = new Date('2026-09-21T12:00:00.000Z');
const HOUR = 3_600_000;
const epoch = (iso: string): number => Math.floor(Date.parse(iso) / 1000);
const TOKEN = 'FAKE-TEST-TOKEN-not-a-real-credential-0123456789';

const skill = (id: number, name: string, category = 'Websites, IT & Software') => ({ id, name, category: { id: 1, name: category } });
const project = (id: number, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  title: `Landing page ${id}`,
  status: 'active',
  sub_status: null,
  seo_url: `website-design/Landing-page-${id}`,
  type: 'fixed',
  jobs: [skill(335, 'HTML'), skill(77, 'CSS', 'Design, Media & Architecture')],
  budget: { minimum: 250, maximum: 500 },
  currency: { code: 'USD', id: 1 },
  bid_stats: { bid_count: 12, bid_avg: 300 },
  time_submitted: epoch('2026-09-20T09:00:00Z'),
  time_updated: epoch('2026-09-20T10:00:00Z'),
  language: 'en',
  description: 'Build a responsive landing page in HTML and CSS.\nDelivery in one week.',
  ...over,
});
const search = (projects: Record<string, unknown>[], total = projects.length) => ({ projects, users: {}, selected_bids: {}, total_count: total });

/** A fake API that answers by path and records every request (paths only). */
function fakeApi(answer: (path: string) => unknown) {
  const calls: string[] = [];
  const api: FreelancerApi = {
    get: async (path: string) => {
      calls.push(path);
      const result = answer(path);
      if (result instanceof Error) throw result;
      return result;
    },
    get requestCount() {
      return calls.length;
    },
  };
  return { api, calls };
}
const jobsAnswer = [skill(335, 'HTML'), skill(77, 'CSS'), skill(9, 'JavaScript'), skill(979, 'Typescript'), skill(759, 'React.js'), skill(69, 'WordPress')];
const standard = (projects: Record<string, unknown>[], total?: number) => (path: string) => (path.includes('/jobs/') ? jobsAnswer : search(projects, total));
const source = (api: FreelancerApi, store = new OpportunityStore(':memory:'), clock = { now: NOW.getTime() }) =>
  ({ store, clock, source: new FreelancerSource({ api, cache: store.sourceCache, skillNames: ['HTML', 'CSS', 'JavaScript', 'TypeScript', 'React', 'WordPress', 'landing page'], now: () => new Date(clock.now) }) });

// ---------- normalization ----------
test('a project from the official response keeps its data: id, page URL, real publication instant, status, proposals and skills', () => {
  const opportunity = toOpportunity(project(4242) as never, NOW.toISOString())!;
  assert.equal(opportunity.sourceId, 'freelancer');
  assert.equal(opportunity.externalId, '4242');
  assert.equal(opportunity.url, 'https://www.freelancer.com/projects/website-design/Landing-page-4242');
  assert.equal(opportunity.title, 'Landing page 4242');
  assert.equal(opportunity.publishedAt, '2026-09-20T09:00:00.000Z', 'the API Unix time is a real instant');
  assert.equal(opportunity.status, 'open');
  assert.equal(opportunity.proposalCount, 12);
  assert.deepEqual(opportunity.skills, ['HTML', 'CSS']);
  assert.equal(opportunity.category, 'Websites, IT & Software', 'a technology skill decides the category');
  assert.equal(opportunity.employmentType, 'freelance');
  assert.equal(opportunity.locationRequirement, undefined, 'no location is invented');
  assert.equal(opportunity.description, 'Build a responsive landing page in HTML and CSS.\nDelivery in one week.');
  assert.equal(opportunity.sourceMetadata.currencyCode, 'USD');
  assert.equal(opportunity.sourceMetadata.dataMaxAgeHours, 24);
  assert.equal(opportunity.sourceMetadata.language, 'en');
});

test('the budget keeps its original currency code, range and kind (fixed or hourly), and is never converted', () => {
  const fixed = normalizeBudget(project(1) as never);
  assert.deepEqual(fixed.budget, { currency: 'USD', kind: 'fixed', min: 250, max: 500 });

  const hourly = normalizeBudget(project(2, { type: 'hourly', currency: { code: 'AUD', id: 3 }, budget: { minimum: 18, maximum: 36 } }) as never);
  assert.deepEqual(hourly.budget, { currency: 'AUD', kind: 'hourly', min: 18, max: 36 });

  for (const code of ['EUR', 'GBP', 'INR', 'CAD', 'BRL']) {
    const budget = normalizeBudget(project(3, { currency: { code, id: 9 }, budget: { minimum: 100, maximum: 200 } }) as never).budget!;
    assert.equal(budget.currency, code);
    assert.equal(budget.min, 100, 'the amount is exactly what the API says');
    assert.equal(budget.max, 200);
  }
  assert.deepEqual(normalizeBudget(project(4, { type: 'hourly', budget: { minimum: 50, maximum: null } }) as never).budget, { currency: 'USD', kind: 'hourly', min: 50, max: null });
  assert.equal(normalizeBudget(project(5, { budget: { minimum: null, maximum: null } }) as never).budget!.kind, 'unknown');
  assert.equal(normalizeBudget(project(6, { budget: undefined }) as never).budget, null);
  assert.equal(normalizeBudget(project(7, { currency: undefined }) as never).budget!.currency, '', 'no currency is assumed');
  assert.equal(normalizeBudget(project(8, { type: 'weird' }) as never).budget!.kind, 'unknown');
});

test('the rate to USD the API publishes for the currency is kept beside the budget, only when it is usable', () => {
  const inr = toOpportunity(project(20, { currency: { code: 'INR', id: 11, exchange_rate: 0.010439 }, budget: { minimum: 12_500, maximum: 37_500 } }) as never, NOW.toISOString())!;
  assert.deepEqual(inr.budget, { currency: 'INR', kind: 'fixed', min: 12_500, max: 37_500 }, 'the original budget is untouched');
  assert.equal(inr.sourceMetadata.exchangeRateToUsd, 0.010439);
  assert.equal(toOpportunity(project(21, { currency: { code: 'USD', id: 1, exchange_rate: 1 } }) as never, 'x')!.sourceMetadata.exchangeRateToUsd, 1);
  for (const exchange_rate of [undefined, null, 0, -2, 'abc']) {
    const opportunity = toOpportunity(project(22, { currency: { code: 'EUR', id: 8, exchange_rate } }) as never, 'x')!;
    assert.equal(opportunity.sourceMetadata.exchangeRateToUsd, null, `rate ${String(exchange_rate)} is not usable`);
  }
});

test('status: only "active" is open; closed is closed; anything else is not confirmed', () => {
  assert.equal(normalizeStatus('active').status, 'open');
  assert.equal(normalizeStatus('closed').status, 'closed');
  assert.equal(normalizeStatus('pending').status, 'unknown');
  assert.equal(normalizeStatus(undefined).status, 'unknown');
  assert.equal(toOpportunity(project(1, { status: 'closed', sub_status: 'closed_expired' }) as never, 'x')!.status, 'closed');
  assert.equal(toOpportunity(project(1, { status: 'closed', sub_status: 'closed_expired' }) as never, 'x')!.sourceMetadata.apiSubStatus, 'closed_expired');
});

test('absent fields stay unknown and unusable entries are dropped, never invented', () => {
  const bare = toOpportunity({ id: 9, title: 'Bare', seo_url: 'x/Bare-9' }, NOW.toISOString())!;
  assert.equal(bare.publishedAt, null);
  assert.equal(bare.proposalCount, null);
  assert.deepEqual(bare.skills, []);
  assert.equal(bare.category, null);
  assert.equal(bare.budget, null);
  assert.equal(bare.description, '');
  assert.equal(bare.status, 'unknown');

  for (const broken of [{ ...project(1), id: undefined }, { ...project(1), id: 'abc' }, { ...project(1), id: -3 }, { ...project(1), title: '  ' }, { ...project(1), seo_url: undefined }, { ...project(1), seo_url: '../../etc/passwd' }, { ...project(1), seo_url: 'a b?x=1' }]) {
    assert.equal(toSummary(broken as never, 'x'), null, JSON.stringify([(broken as Record<string, unknown>).seo_url, (broken as Record<string, unknown>).id]));
  }
  assert.equal(projectUrl('a/b-1'), 'https://www.freelancer.com/projects/a/b-1');
  assert.equal(projectUrl('https://evil.example/x'), null);
});

test('a project without a technology skill takes the category of its first skill; the description is bounded plain text', () => {
  const design = toOpportunity(project(1, { jobs: [skill(5, 'Logo Design', 'Design, Media & Architecture')] }) as never, 'x')!;
  assert.equal(design.category, 'Design, Media & Architecture');
  const text = plainText('Line one\r\n\r\n\r\n\r\nLine\u0000 two​ with   spaces\t\t!');
  assert.equal(text, 'Line one\n\nLine two with spaces !');
  assert.ok(plainText('palavra '.repeat(5000), 1000).length <= 1001);
});

test('the search response is read with its total; a response without projects is an error', () => {
  const parsed = parseSearchResult(search([project(1), project(2)], 680));
  assert.equal(parsed.projects.length, 2);
  assert.equal(parsed.total, 680);
  assert.throws(() => parseSearchResult({ users: {} }), SourceResponseError);
  assert.throws(() => parseSearchResult(null), SourceResponseError);
});

// ---------- the source ----------
test('the listing asks the official endpoint for active, recent, skill-filtered, newest-first projects with full data', async () => {
  const { api, calls } = fakeApi(standard([project(1), project(2)]));
  const { source: fl } = source(api);
  const page = await fl.listRecent();

  assert.equal(calls.length, 2, 'one request for the skill ids, one for the projects');
  assert.match(calls[0]!, /^\/api\/projects\/0\.1\/jobs\/\?/);
  assert.match(calls[0]!, /job_names%5B%5D=React\.js/, 'the profile name "React" is looked up as the API spells it');
  assert.match(calls[0]!, /job_names%5B%5D=landing%20page/);
  const listing = calls[1]!;
  assert.ok(listing.startsWith('/api/projects/0.1/projects/active/?'));
  assert.match(listing, /limit=20/);
  assert.match(listing, /offset=0/);
  assert.match(listing, /sort_field=submitdate/);
  assert.ok(!/reverse_sort/.test(listing), 'reverse_sort would return the OLDEST first');
  assert.match(listing, /full_description=true/);
  assert.match(listing, /job_details=true/);
  for (const id of [335, 77, 9, 979, 759, 69]) assert.ok(listing.includes(`jobs%5B%5D=${id}`), `skill ${id}`);
  const from = Number(/from_time=(\d+)/.exec(listing)![1]);
  assert.equal(from, Math.floor(NOW.getTime() / 1000) - 7 * 86_400, 'the last 7 days');
  assert.ok(!listing.includes('FAKE') && !calls.join('').includes('token'));
  assert.equal(page.items.length, 2);
  assert.equal(page.nextCursor, null);
});

test('projects come newest first whatever the page order, and a full page continues with the next offset', async () => {
  const older = project(1, { time_submitted: epoch('2026-09-19T00:00:00Z') });
  const newer = project(2, { time_submitted: epoch('2026-09-21T10:00:00Z') });
  const pageOf = (n: number) => Array.from({ length: 20 }, (_, i) => project(100 + n * 20 + i));
  const one = fakeApi(standard([older, newer]));
  assert.deepEqual((await source(one.api).source.listRecent()).items.map((item) => item.externalId), ['2', '1']);

  const full = fakeApi(standard(pageOf(0), 45));
  const first = await source(full.api).source.listRecent();
  assert.equal(first.nextCursor, '20');
  const second = fakeApi(standard(pageOf(1), 45));
  const held = source(second.api);
  const next = await held.source.listRecent('20');
  assert.match(second.calls.at(-1)!, /offset=20/);
  assert.equal(next.nextCursor, '40');
  const last = fakeApi(standard([project(1)], 41));
  assert.equal((await source(last.api).source.listRecent('40')).nextCursor, null, 'a short last page ends it');
  await assert.rejects(source(one.api).source.listRecent('abc'), /Invalid freelancer cursor/);
});

test('the skill ids are kept for 24 hours and looked up again after that', async () => {
  const { api, calls } = fakeApi(standard([project(1)]));
  const store = new OpportunityStore(':memory:');
  const clock = { now: NOW.getTime() };
  await source(api, store, clock).source.listRecent();
  assert.equal(calls.filter((path) => path.includes('/jobs/')).length, 1);

  clock.now += 3 * HOUR;
  await source(api, store, clock).source.listRecent(); // a new instance, as after a restart
  assert.equal(calls.filter((path) => path.includes('/jobs/')).length, 1, 'still cached');

  clock.now += 22 * HOUR;
  await source(api, store, clock).source.listRecent();
  assert.equal(calls.filter((path) => path.includes('/jobs/')).length, 2, 'refreshed after 24 hours');
});

test('no resolvable skill means an error, never a search without a skill filter', async () => {
  const { api, calls } = fakeApi((path) => (path.includes('/jobs/') ? [] : search([project(1)])));
  await assert.rejects(source(api).source.listRecent(), /None of the profile skills/);
  assert.ok(!calls.some((path) => path.includes('/projects/active/')), 'the listing was not requested');
});

test('a project listed in this run is used as it is; one from an earlier run is fetched again, live', async () => {
  const { api, calls } = fakeApi((path) => (path.includes('/jobs/') ? jobsAnswer : path.includes('/projects/active/') ? search([project(1)]) : project(99, { title: 'Fresh copy' })));
  const { source: fl } = source(api);
  await fl.listRecent();
  const before = calls.length;
  assert.equal((await fl.fetchDetail('1')).title, 'Landing page 1');
  assert.equal(calls.length, before, 'no request for a project of the same listing');

  const live = await fl.fetchDetail('99');
  assert.equal(live.title, 'Fresh copy');
  assert.equal(calls.length, before + 1);
  assert.match(calls.at(-1)!, /^\/api\/projects\/0\.1\/projects\/99\/\?full_description=true&job_details=true$/);
  await assert.rejects(fl.fetchDetail('abc'), /Invalid freelancer externalId/);
});

test('a detail answer for another project, or with no project, is not accepted', async () => {
  const mismatch = fakeApi((path) => (path.includes('/jobs/') ? jobsAnswer : project(5)));
  await assert.rejects(source(mismatch.api).source.fetchDetail('7'), SourceResponseError);
  const none = fakeApi(() => ({ nothing: true }));
  await assert.rejects(source(none.api).source.fetchDetail('7'), SourceNotFoundError);
  const gone = fakeApi(() => new SourceNotFoundError('gone'));
  await assert.rejects(source(gone.api).source.fetchDetail('7'), SourceNotFoundError);
});

// ---------- refusals, cooldown, no repetition ----------
test('after a 401 the source stops, says the token may have expired, and does not insist on the next runs', async () => {
  const auth = new SourceAuthError('the token may have expired');
  const { api, calls } = fakeApi(() => auth);
  const store = new OpportunityStore(':memory:');
  const clock = { now: NOW.getTime() };

  await assert.rejects(source(api, store, clock).source.listRecent(), SourceAuthError);
  assert.equal(calls.length, 1);
  for (const hours of [1, 3, 5]) {
    clock.now = NOW.getTime() + hours * HOUR;
    await assert.rejects(source(api, store, clock).source.listRecent(), /was not queried: waiting until/);
  }
  assert.equal(calls.length, 1, 'no request during the cooldown, even from a new process');
  clock.now = NOW.getTime() + 6 * HOUR;
  await assert.rejects(source(api, store, clock).source.listRecent(), SourceAuthError);
  assert.equal(calls.length, 2, 'one new attempt after the cooldown');
});

test('a 429 waits for Retry-After when it is longer than the cooldown; a good answer clears the cooldown', async () => {
  const store = new OpportunityStore(':memory:');
  const clock = { now: NOW.getTime() };
  let mode: 'limit' | 'ok' = 'limit';
  const { api, calls } = fakeApi((path) => (mode === 'limit' ? new SourceBlockedError('HTTP 429', 43_200) : path.includes('/jobs/') ? jobsAnswer : search([project(1)])));

  await assert.rejects(source(api, store, clock).source.listRecent(), SourceBlockedError);
  assert.equal(store.sourceCache.get('freelancer')!.nextAttemptAt, new Date(NOW.getTime() + 12 * HOUR).toISOString());
  clock.now = NOW.getTime() + 8 * HOUR;
  await assert.rejects(source(api, store, clock).source.listRecent(), /was not queried/);
  assert.equal(calls.length, 1);

  mode = 'ok';
  clock.now = NOW.getTime() + 12 * HOUR;
  assert.equal((await source(api, store, clock).source.listRecent()).items.length, 1);
  assert.equal(store.sourceCache.get('freelancer')!.nextAttemptAt, new Date(NOW.getTime() + 12 * HOUR).toISOString(), 'no future wait remains');
  assert.equal((await source(api, store, clock).source.listRecent()).items.length, 1, 'and the next run is allowed');
});

test('a 403 is a refusal too: it stops without retry', async () => {
  const { api, calls } = fakeApi(() => new SourceBlockedError('HTTP 403'));
  const { source: fl } = source(api);
  await assert.rejects(fl.listRecent(), SourceBlockedError);
  await assert.rejects(fl.listRecent(), /was not queried/);
  assert.equal(calls.length, 1);
});

// ---------- the HTTP client ----------
const respond = (status: number, body: unknown, headers: Record<string, string> = {}) => () =>
  Promise.resolve(new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } }));
const client = (fetchFn: (url: string, init?: RequestInit) => Promise<Response>, timeoutMs = 200) =>
  new FreelancerClient(TOKEN, { fetchFn: fetchFn as unknown as typeof fetch, minIntervalMs: 0, timeoutMs });

test('the client sends the token only in its header and returns the result of a successful answer', async () => {
  let seen: { url: string; headers: Record<string, string> } | null = null;
  const c = client(async (url, init) => {
    seen = { url: String(url), headers: init?.headers as Record<string, string> };
    return new Response(JSON.stringify({ status: 'success', result: { projects: [] }, request_id: 'r' }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  assert.deepEqual(await c.get('/api/projects/0.1/projects/active/?limit=1'), { projects: [] });
  assert.equal(seen!.url, 'https://www.freelancer.com/api/projects/0.1/projects/active/?limit=1');
  assert.equal(seen!.headers['Freelancer-OAuth-V1'], TOKEN);
  assert.ok(!seen!.url.includes(TOKEN), 'never in the URL');
  assert.equal(c.requestCount, 1);
  await assert.rejects(c.get('https://evil.example/api/x'), /outside the Freelancer\.com API/);
  await assert.rejects(c.get('/somewhere/else'), /outside the Freelancer\.com API/);
});

test('401 asks for a new 30-day token without revealing the current one; 403 and 429 are refusals with Retry-After', async () => {
  await assert.rejects(client(respond(401, { status: 'error', message: TOKEN })).get('/api/x'), (error: unknown) => {
    assert.ok(error instanceof SourceAuthError);
    assert.match(error.message, /expired/);
    assert.match(error.message, /30 days/);
    assert.match(error.message, /FREELANCER_OAUTH_TOKEN/);
    assert.ok(!error.message.includes(TOKEN));
    return true;
  });
  await assert.rejects(client(respond(403, {})).get('/api/x'), (error: unknown) => error instanceof SourceBlockedError && /HTTP 403/.test(error.message));
  await assert.rejects(client(respond(429, {}, { 'retry-after': '120' })).get('/api/x'), (error: unknown) => error instanceof SourceBlockedError && error.retryAfterSeconds === 120);
  await assert.rejects(client(respond(429, {})).get('/api/x'), (error: unknown) => error instanceof SourceBlockedError && error.retryAfterSeconds === null);
});

test('other answers are classified: 404, server errors, wrong content, bad JSON, API error bodies', async () => {
  await assert.rejects(client(respond(404, {})).get('/api/x'), SourceNotFoundError);
  await assert.rejects(client(respond(500, {})).get('/api/x'), /Unexpected HTTP 500/);
  await assert.rejects(client(async () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } })).get('/api/x'), /Expected JSON/);
  await assert.rejects(client(respond(200, 'not json')).get('/api/x'), /not valid JSON/);
  await assert.rejects(client(respond(200, { status: 'error', message: `bad ${TOKEN}`, error_code: 'Foo' })).get('/api/x'), (error: unknown) => error instanceof SourceResponseError && /\(Foo\)/.test(error.message) && !error.message.includes(TOKEN));
  await assert.rejects(client(respond(200, { status: 'error', message: 'nope', error_code: 'ProjectNotFound' })).get('/api/x'), SourceNotFoundError);
});

test('a timeout and a network failure are errors that never contain the token', async () => {
  await assert.rejects(client(() => Promise.reject(new DOMException('timed out', 'TimeoutError')), 150).get('/api/x?q=1'), (error: unknown) => error instanceof SourceResponseError && /timed out/.test(error.message) && !error.message.includes('q=1'));
  await assert.rejects(client(() => Promise.reject(new TypeError(`fetch failed for ${TOKEN}`))).get('/api/x'), (error: unknown) => error instanceof SourceResponseError && !error.message.includes(TOKEN));
});

// ---------- configuration and isolation ----------
const quiet = (): void => {};

test('without the token only the Freelancer source is skipped, with a short message that never shows a value', async () => {
  const config = loadConfig({ SOURCES: 'freelancer' }, quiet);
  assert.equal(config.freelancerToken, null);
  const store = new OpportunityStore(':memory:');
  const runs = createSourceRuns(config, store);
  assert.equal(runs[0]!.disabledReason !== null, true);

  const lines: string[] = [];
  const { exitCode, outcomes } = await collectSources(runs, store, donBrunoProfile, (line) => lines.push(line));
  assert.equal(exitCode, 0, 'not a failure');
  assert.ok(outcomes[0]!.disabled);
  assert.equal(runs[0]!.requestCount(), 0);
  assert.ok(lines.join('\n').includes('FREELANCER_OAUTH_TOKEN is not set'));

  const withToken = loadConfig({ SOURCES: 'freelancer', FREELANCER_OAUTH_TOKEN: `  ${TOKEN}  ` }, quiet);
  assert.equal(withToken.freelancerToken, TOKEN, 'trimmed');
  assert.equal(createSourceRuns(withToken, store)[0]!.disabledReason, null);
  // Depth is the source's own setting: 5 pages by default, and DISCOVERY_MAX_PAGES (99Freelas) does not touch it.
  assert.equal(createSourceRuns(withToken, store)[0]!.limits.maxPages, 5);
  const deeper = loadConfig({ SOURCES: '99freelas,freelancer', FREELANCER_OAUTH_TOKEN: TOKEN, FREELANCER_MAX_PAGES: '8', DISCOVERY_MAX_PAGES: '2' }, quiet);
  const [legacy, freelancer] = createSourceRuns(deeper, store);
  assert.equal(freelancer!.limits.maxPages, 8);
  assert.equal(freelancer!.limits.maxDetailsPerRun, 160);
  assert.equal(legacy!.limits.maxPages, 2, 'the other source keeps its own limit');
  assert.deepEqual(loadConfig({ SOURCES: '99freelas,remotive,freelancer' }, quiet).sources, ['99freelas', 'remotive', 'freelancer']);
  assert.deepEqual(loadConfig({}, quiet).sources, ['99freelas'], 'off by default');
});

test('a missing token or a 401 in Freelancer never stops the other sources', async () => {
  const store = new OpportunityStore(':memory:');
  const { api } = fakeApi(() => new SourceAuthError('token expired'));
  const failing = { ...createSourceRuns(loadConfig({ SOURCES: 'freelancer', FREELANCER_OAUTH_TOKEN: TOKEN }, quiet), store)[0]!, source: source(api, store).source };
  const healthy = {
    name: '99freelas' as const,
    label: '99Freelas',
    source: { id: '99freelas', listRecent: async () => ({ items: [], nextCursor: null }), fetchDetail: async () => { throw new Error('unused'); } },
    limits: { maxPages: 1, targetNew: 1, maxDetailsPerRun: 1 },
    requestCount: () => 0,
    notes: () => [],
    disabledReason: null,
  };
  const lines: string[] = [];
  const { outcomes } = await collectSources([failing, healthy], store, donBrunoProfile, (line) => lines.push(line));
  assert.equal(outcomes[0]!.report!.stopReason, 'source-error');
  assert.match(outcomes[0]!.report!.stopDetail ?? '', /expired/);
  assert.equal(outcomes[1]!.report!.stopReason, 'source-exhausted', 'the other source ran');
  assert.ok(!lines.join('\n').includes(TOKEN));
});

test('in the pipeline: the rate the API publishes is kept per source and currency with its observation time, and reused by older rows', async () => {
  const store = new OpportunityStore(':memory:');
  const inr = project(1, { currency: { code: 'INR', id: 11, exchange_rate: 0.0104 }, budget: { minimum: 12_500, maximum: 37_500 } });
  const { api } = fakeApi(standard([inr, project(2)]));
  await runPipeline({ source: source(api, store).source, store, profile: donBrunoProfile, maxPages: 1, targetNew: 100, maxDetailsPerRun: 20, now: () => NOW });

  assert.deepEqual(store.exchangeRates.lookup('freelancer', 'INR'), { rateToUsd: 0.0104, observedAt: NOW.toISOString() });
  assert.equal(store.exchangeRates.lookup('freelancer', 'USD'), null, 'a currency the API published no rate for is not invented');
  assert.equal(store.exchangeRates.lookup('remotive', 'INR'), null, 'a rate belongs to its source');
  assert.deepEqual(store.get({ sourceId: 'freelancer', externalId: '1' })!.opportunity.budget, { currency: 'INR', kind: 'fixed', min: 12_500, max: 37_500 }, 'the original budget is kept');
});

test('in the pipeline: stored once, the second run finds them known, and the same id in another source is another opportunity', async () => {
  const store = new OpportunityStore(':memory:');
  const { api, calls } = fakeApi(standard([project(1), project(2, { title: 'Senior WordPress team member', description: 'Join our team long term.' })]));
  const { source: fl } = source(api, store);
  const options = { source: fl, store, profile: donBrunoProfile, maxPages: 1, targetNew: 100, maxDetailsPerRun: 20, now: () => NOW };

  const first = await runPipeline(options);
  assert.equal(first.newSummaries, 2);
  assert.equal(first.detailsObtained, 2);
  assert.equal(calls.filter((path) => path.includes('/projects/active/')).length, 1, 'details came from the listing');
  assert.equal(store.get({ sourceId: 'freelancer', externalId: '1' })!.filter.decision, 'shortlist');
  assert.equal(store.get({ sourceId: 'freelancer', externalId: '2' })!.filter.decision, 'skip', 'a continuing team role is stored, not alerted');

  const second = await runPipeline(options);
  assert.equal(second.alreadyKnown, 2);
  assert.equal(second.newSummaries, 0);
  assert.equal(second.detailsAttempted, 0);
  assert.equal(store.count(), 2, 'no duplicate');

  store.insert({ ...store.get({ sourceId: 'freelancer', externalId: '1' })!.opportunity, sourceId: 'remotive' }, store.get({ sourceId: 'freelancer', externalId: '1' })!.filter, NOW.toISOString());
  assert.equal(store.count(), 3, 'the same id under another source is a different opportunity');
  store.markNotified({ sourceId: 'remotive', externalId: '1' }, NOW.toISOString());
  assert.equal(store.get({ sourceId: 'freelancer', externalId: '1' })!.notifiedAt, null);
});
