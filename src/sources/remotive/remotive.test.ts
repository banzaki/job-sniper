import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { donBrunoProfile } from '../../profile/don-bruno.js';
import { runPipeline } from '../../pipeline/run-pipeline.js';
import { OpportunityStore } from '../../storage/opportunity-store.js';
import { SourceBlockedError, SourceNotFoundError, SourceResponseError } from '../source-errors.js';
import { htmlToText } from './html-to-text.js';
import { normalizeEmploymentType, parsePublished, remotiveUrl, toOpportunity } from './remotive-parser.js';
import { MIN_INTERVAL_HOURS, parseRetryAfter, RemotiveSource } from './remotive-source.js';

const workDir = mkdtempSync(join(tmpdir(), 'job-sniper-remotive-'));
after(() => rmSync(workDir, { recursive: true, force: true }));

const T0 = Date.parse('2026-09-21T12:00:00.000Z');
const HOUR = 3_600_000;

const job = (id: number | string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  url: `https://remotive.com/remote-jobs/software-dev/job-${id}`,
  title: `Front-end developer ${id}`,
  company_name: 'Acme',
  category: 'Software Development',
  tags: ['react', 'javascript'],
  job_type: 'contract',
  publication_date: '2026-09-20T13:15:01',
  candidate_required_location: 'Worldwide',
  salary: '$50k - $70k',
  description: '<p>Build a <b>React</b> landing page.</p>',
  ...over,
});
const feed = (jobs: Record<string, unknown>[]): string => JSON.stringify({ '0-legal-notice': 'Remotive legal notice', 'job-count': jobs.length, jobs });
const json = (body: string, headers: Record<string, string> = {}) =>
  new Response(body, { status: 200, headers: { 'content-type': 'application/json', ...headers } });

/** A fake fetch that answers from a script and counts requests. The clock is shared with the source. */
function harness(store: OpportunityStore, responses: (() => Response | Promise<Response>)[], minIntervalHours?: number) {
  const clock = { now: T0 };
  const calls: string[] = [];
  const fetchFn = (async (url: string) => {
    calls.push(url);
    const next = responses.shift();
    if (!next) throw new Error('unexpected extra request');
    return next();
  }) as unknown as typeof fetch;
  const source = new RemotiveSource({
    cache: store.sourceCache,
    fetchFn,
    now: () => new Date(clock.now),
    ...(minIntervalHours ? { minIntervalHours } : {}),
  });
  return { clock, calls, source };
}

// ---------- normalization ----------
test('a complete job keeps its data as published: type, location, pay text, company and the original Remotive URL', () => {
  const opportunity = toOpportunity(job(101) as never, { feedFetchedAt: '2026-09-21T12:00:00.000Z' })!;
  assert.equal(opportunity.sourceId, 'remotive');
  assert.equal(opportunity.externalId, '101');
  assert.equal(opportunity.url, 'https://remotive.com/remote-jobs/software-dev/job-101');
  assert.equal(opportunity.title, 'Front-end developer 101');
  assert.equal(opportunity.employmentType, 'contract');
  assert.equal(opportunity.locationRequirement, 'Worldwide');
  assert.equal(opportunity.compensation, '$50k - $70k');
  assert.deepEqual(opportunity.skills, ['react', 'javascript']);
  assert.equal(opportunity.category, 'Software Development');
  assert.equal(opportunity.description, 'Build a React landing page.');
  assert.equal(opportunity.sourceMetadata.company, 'Acme');
  assert.equal(opportunity.sourceMetadata.feedDelayHours, 24);
});

test('the pay text is never turned into a budget, a currency, a period or a converted number', () => {
  for (const salary of ['$50k - $70k', '€60,000/year', '50-70 USD/hour', 'R$ 8.000 por mês', 'competitive']) {
    const opportunity = toOpportunity(job(1, { salary }) as never, { feedFetchedAt: 'x' })!;
    assert.equal(opportunity.compensation, salary, 'exactly as published');
    assert.equal(opportunity.budget, null, 'a salary is not a project budget');
  }
});

test('absent fields stay unknown: nothing is invented for type, location, pay, tags, date, company or access', () => {
  const bare = { id: 7, url: 'https://remotive.com/remote-jobs/x/7', title: 'Bare' };
  const opportunity = toOpportunity(bare as never, { feedFetchedAt: '2026-09-21T12:00:00.000Z' })!;
  assert.equal(opportunity.employmentType, 'unknown');
  assert.equal(opportunity.locationRequirement, null);
  assert.equal(opportunity.compensation, null);
  assert.deepEqual(opportunity.skills, []);
  assert.equal(opportunity.publishedAt, null);
  assert.equal(opportunity.sourceMetadata.company, null);
  assert.equal(opportunity.sourceMetadata.publishedRaw, null);
  assert.equal(opportunity.category, null);
  assert.equal(opportunity.description, '');
  assert.equal(opportunity.summary, null);
  assert.equal(opportunity.budget, null);
  assert.deepEqual(opportunity.access, { kind: 'unknown', publicAt: null, rawLabel: null });
  assert.equal(opportunity.proposalCount, null);
  assert.equal(opportunity.experienceLevel, null);
});

test('the engagement type is normalized without presumptions: contract stays contract, missing stays unknown', () => {
  assert.equal(normalizeEmploymentType('freelance'), 'freelance');
  assert.equal(normalizeEmploymentType('contract'), 'contract');
  assert.equal(normalizeEmploymentType('full_time'), 'full_time');
  assert.equal(normalizeEmploymentType('Full-Time'), 'full_time');
  assert.equal(normalizeEmploymentType('part_time'), 'part_time');
  assert.equal(normalizeEmploymentType('internship'), 'internship');
  assert.equal(normalizeEmploymentType(undefined), 'unknown');
  assert.equal(normalizeEmploymentType(''), 'unknown');
  assert.equal(normalizeEmploymentType('   '), 'unknown');
  assert.equal(normalizeEmploymentType('temporary'), 'other');
  const opportunity = toOpportunity(job(9, { job_type: 'temporary' }) as never, { feedFetchedAt: 'x' })!;
  assert.equal(opportunity.employmentType, 'other');
  assert.equal(opportunity.sourceMetadata.jobTypeRaw, 'temporary', 'the published label is kept');
});

test('a publication time without a time zone is not turned into an instant; one with a zone is', () => {
  assert.deepEqual(parsePublished('2026-09-20T13:15:01'), { iso: null, raw: '2026-09-20T13:15:01', timezone: 'not stated', day: '2026-09-20' });
  assert.deepEqual(parsePublished('2026-09-20'), { iso: null, raw: '2026-09-20', timezone: 'not stated', day: '2026-09-20' });
  assert.equal(parsePublished('2026-09-20T13:15:01Z').iso, '2026-09-20T13:15:01.000Z');
  assert.equal(parsePublished('2026-09-20T13:15:01-03:00').iso, '2026-09-20T16:15:01.000Z');
  assert.deepEqual(parsePublished('yesterday'), { iso: null, raw: 'yesterday', timezone: 'unusable', day: null });
  assert.deepEqual(parsePublished(null), { iso: null, raw: null, timezone: 'unusable', day: null });
  const opportunity = toOpportunity(job(3) as never, { feedFetchedAt: 'x' })!;
  assert.equal(opportunity.publishedAt, null);
  assert.equal(opportunity.sourceMetadata.publishedRaw, '2026-09-20T13:15:01');
  assert.equal(opportunity.sourceMetadata.publishedTimezone, 'not stated');
  assert.equal(opportunity.sourceMetadata.publishedDay, '2026-09-20', 'only the calendar day is kept');
});

test('identity is the API id: numbers and digit strings are accepted, anything else drops the entry', () => {
  assert.equal(toOpportunity(job(555) as never, { feedFetchedAt: 'x' })!.externalId, '555');
  assert.equal(toOpportunity(job('556') as never, { feedFetchedAt: 'x' })!.externalId, '556');
  for (const id of [undefined, null, 0, -4, 1.5, '', 'abc', '12x', {}, [] as unknown]) {
    assert.equal(toOpportunity(job(1, { id }) as never, { feedFetchedAt: 'x' }), null, `id ${JSON.stringify(id)}`);
  }
  assert.equal(toOpportunity(job(1, { title: '  ' }) as never, { feedFetchedAt: 'x' }), null, 'no title');
});

test('only https pages on remotive.com count as the original URL', () => {
  assert.equal(remotiveUrl('https://remotive.com/remote-jobs/a/1'), 'https://remotive.com/remote-jobs/a/1');
  assert.equal(remotiveUrl('https://www.remotive.com/x'), 'https://www.remotive.com/x');
  for (const bad of ['http://remotive.com/x', 'https://evil.example/remotive.com', 'https://remotive.com.evil.example/x', 'javascript:alert(1)', 'not a url', '', null, 7]) {
    assert.equal(remotiveUrl(bad), null, String(bad));
  }
  assert.equal(toOpportunity(job(1, { url: 'https://evil.example/x' }) as never, { feedFetchedAt: 'x' }), null);
});

// ---------- HTML ----------
test('HTML becomes plain text safely: scripts, styles, handlers and links are dropped, entities decoded, structure kept', () => {
  const html =
    '<p>Hello &amp; welcome</p><script>alert("x")</script><style>p{color:red}</style>' +
    '<ul><li>React</li><li>Node &lt;18&gt;</li></ul><p>Apply <a href="javascript:alert(1)" onclick="steal()">here</a>.</p>' +
    '<img src="x" onerror="alert(1)"><iframe src="https://evil.example"></iframe>Line one<br>Line two';
  const text = htmlToText(html);
  assert.ok(text.includes('Hello & welcome'));
  assert.ok(text.includes('- React') && text.includes('- Node <18>'));
  assert.ok(text.includes('Apply here.'));
  assert.ok(text.includes('Line one\nLine two'));
  for (const forbidden of ['alert', 'javascript:', 'onclick', 'onerror', 'evil.example', 'color:red', '<script', '<img']) {
    assert.ok(!text.includes(forbidden), forbidden);
  }
});

test('the description is bounded and empty markup gives an empty text', () => {
  assert.equal(htmlToText(''), '');
  assert.equal(htmlToText('<p> </p><br>'), '');
  const long = htmlToText(`<p>${'palavra '.repeat(5000)}</p>`, 1000);
  assert.ok(long.length <= 1001 && long.endsWith('…'));
});

// ---------- the source: one request, cache, interval ----------
test('one query lists the whole feed, and every "detail" comes from the stored response with no further request', async () => {
  const store = new OpportunityStore(':memory:');
  const { source, calls } = harness(store, [() => json(feed([job(1), job(2), job(3, { url: 'https://evil.example/3' })]))]);

  const page = await source.listRecent();
  assert.equal(page.items.length, 2, 'the entry with a foreign URL is dropped');
  assert.equal(page.nextCursor, null);
  assert.deepEqual(page.items.map((item) => item.externalId), ['1', '2']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0], 'https://remotive.com/api/remote-jobs?category=software-dev');

  const detail = await source.fetchDetail('2');
  assert.equal(detail.externalId, '2');
  assert.equal(detail.locationRequirement, 'Worldwide');
  assert.equal(calls.length, 1, 'no request per job');
  assert.equal(source.requestCount, 1);
  assert.deepEqual((await source.listRecent('2')).items, [], 'there is no second page');
  assert.equal(calls.length, 1);
});

test('the cache is used for 6 hours, the interval is measured from the attempt, and the next query then happens', async () => {
  const store = new OpportunityStore(':memory:');
  const { source, clock, calls } = harness(store, [() => json(feed([job(1)])), () => json(feed([job(1), job(2)]))]);

  await source.listRecent();
  assert.equal(source.lastLoad.mode, 'network');
  const entry = store.sourceCache.get('remotive')!;
  assert.equal(entry.nextAttemptAt, new Date(T0 + 6 * HOUR).toISOString());
  assert.equal(entry.attempts, 1);

  clock.now = T0 + HOUR;
  const again = await source.listRecent();
  assert.equal(calls.length, 1, 'an intermediate run reuses the cache');
  assert.equal(source.lastLoad.mode, 'cache');
  assert.equal(again.items.length, 1);

  clock.now = T0 + 6 * HOUR - 1;
  await source.listRecent();
  assert.equal(calls.length, 1, 'one millisecond before the interval is still cache');

  clock.now = T0 + 6 * HOUR;
  const fresh = await source.listRecent();
  assert.equal(calls.length, 2);
  assert.equal(source.lastLoad.mode, 'network');
  assert.equal(fresh.items.length, 2);
  assert.equal(store.sourceCache.get('remotive')!.attempts, 2);
});

test('the cache and the attempt clock survive a restart: no query, and details still come from the stored response', async () => {
  const path = join(workDir, 'restart.db');
  const first = new OpportunityStore(path);
  const one = harness(first, [() => json(feed([job(1, { salary: '$80k' }), job(2)]))]);
  await one.source.listRecent();
  first.close();

  const reopened = new OpportunityStore(path);
  const two = harness(reopened, []); // any request would throw "unexpected extra request"
  two.clock.now = T0 + 2 * HOUR;
  const page = await two.source.listRecent();
  assert.equal(page.items.length, 2);
  assert.equal(two.calls.length, 0, 'no new query after the restart');
  assert.equal(two.source.lastLoad.mode, 'cache');
  const detail = await two.source.fetchDetail('1');
  assert.equal(detail.compensation, '$80k');
  assert.equal(two.calls.length, 0);
  reopened.close();
});

test('a failed query counts as a query: it is not repeated in sequence, and the older response keeps being served', async () => {
  const store = new OpportunityStore(':memory:');
  const { source, clock, calls } = harness(store, [() => json(feed([job(1)])), () => { throw new TypeError('fetch failed'); }]);
  await source.listRecent();

  clock.now = T0 + 6 * HOUR;
  const stale = await source.listRecent();
  assert.equal(calls.length, 2);
  assert.equal(stale.items.length, 1, 'the stored response is served instead of failing');
  assert.equal(source.lastLoad.mode, 'stale');
  assert.match(source.lastLoad.note ?? '', /fetch failed/);
  const entry = store.sourceCache.get('remotive')!;
  assert.equal(entry.consecutiveFailures, 1);
  assert.equal(entry.nextAttemptAt, new Date(T0 + 12 * HOUR).toISOString(), 'the next attempt waits a full interval');

  for (const minutes of [1, 30, 300]) {
    clock.now = T0 + 6 * HOUR + minutes * 60_000;
    await source.listRecent();
    assert.equal(calls.length, 2, 'no repeated query after the failure');
  }
});

test('with nothing stored yet, a failure raises the error, and the next run inside the interval makes no request', async () => {
  const store = new OpportunityStore(':memory:');
  const { source, clock, calls } = harness(store, [() => new Response('boom', { status: 500 })]);
  await assert.rejects(source.listRecent(), (error: unknown) => error instanceof SourceResponseError && /HTTP 500/.test(error.message));
  assert.equal(calls.length, 1);

  clock.now = T0 + HOUR;
  await assert.rejects(source.listRecent(), /was not queried/);
  assert.equal(calls.length, 1, 'no second request');
  await assert.rejects(source.fetchDetail('1'), SourceNotFoundError);

  clock.now = T0 + 6 * HOUR; // the interval is over: a query is allowed again
  const retry = harness(store, [() => json(feed([job(1)]))]);
  retry.clock.now = T0 + 6 * HOUR;
  assert.equal((await retry.source.listRecent()).items.length, 1);
});

test('HTTP 429 stops querying and respects Retry-After when it is longer than the interval', async () => {
  const store = new OpportunityStore(':memory:');
  const { source, clock, calls } = harness(store, [() => new Response('slow down', { status: 429, headers: { 'retry-after': '86400' } })]);
  await assert.rejects(source.listRecent(), (error: unknown) => error instanceof SourceBlockedError && error.retryAfterSeconds === 86400);
  assert.equal(store.sourceCache.get('remotive')!.nextAttemptAt, new Date(T0 + 24 * HOUR).toISOString());

  clock.now = T0 + 12 * HOUR; // past the plain 6 h, but Retry-After said 24 h
  await assert.rejects(source.listRecent(), /was not queried/);
  assert.equal(calls.length, 1);
});

test('HTTP 429 without Retry-After waits the normal interval; a Retry-After shorter than it does not shorten it', async () => {
  const store = new OpportunityStore(':memory:');
  const { source } = harness(store, [() => new Response('', { status: 429 })]);
  await assert.rejects(source.listRecent(), SourceBlockedError);
  assert.equal(store.sourceCache.get('remotive')!.nextAttemptAt, new Date(T0 + 6 * HOUR).toISOString());

  const second = new OpportunityStore(':memory:');
  const { source: other } = harness(second, [() => new Response('', { status: 429, headers: { 'retry-after': '30' } })]);
  await assert.rejects(other.listRecent(), SourceBlockedError);
  assert.equal(second.sourceCache.get('remotive')!.nextAttemptAt, new Date(T0 + 6 * HOUR).toISOString());
});

test('a 429 with a stored response ends the querying but keeps serving the stored data', async () => {
  const store = new OpportunityStore(':memory:');
  const { source, clock, calls } = harness(store, [() => json(feed([job(1)])), () => new Response('', { status: 429, headers: { 'retry-after': '43200' } })]);
  await source.listRecent();
  clock.now = T0 + 6 * HOUR;
  const page = await source.listRecent();
  assert.equal(page.items.length, 1);
  assert.equal(source.lastLoad.mode, 'stale');
  assert.match(source.lastLoad.note ?? '', /HTTP 429/);
  assert.equal(store.sourceCache.get('remotive')!.nextAttemptAt, new Date(T0 + 18 * HOUR).toISOString());
  clock.now = T0 + 17 * HOUR;
  await source.listRecent();
  assert.equal(calls.length, 2);
});

test('Retry-After is read as seconds or as a date, and nonsense is ignored', () => {
  const now = new Date('2026-09-21T12:00:00.000Z');
  assert.equal(parseRetryAfter('120', now), 120);
  assert.equal(parseRetryAfter('Mon, 21 Sep 2026 13:00:00 GMT', now), 3600);
  assert.equal(parseRetryAfter('Mon, 21 Sep 2026 11:00:00 GMT', now), null, 'a date in the past');
  assert.equal(parseRetryAfter('0', now), null);
  assert.equal(parseRetryAfter('soon', now), null);
  assert.equal(parseRetryAfter(null, now), null);
  assert.equal(parseRetryAfter('99999999', now), 7 * 24 * 3600, 'bounded');
});

test('a bad response never replaces a good stored one', async () => {
  const store = new OpportunityStore(':memory:');
  const { source, clock } = harness(store, [() => json(feed([job(1)])), () => json('{"jobs": []}'), () => json('<html>oops</html>'), () => json('not json')]);
  await source.listRecent();
  const good = store.sourceCache.get('remotive')!.payloadJson;

  for (const hours of [6, 12, 18]) {
    clock.now = T0 + hours * HOUR;
    const page = await source.listRecent();
    assert.equal(page.items.length, 1, 'still serving the good response');
    assert.equal(source.lastLoad.mode, 'stale');
    assert.equal(store.sourceCache.get('remotive')!.payloadJson, good, 'the good payload is untouched');
  }
});

test('the interval can be longer than 6 hours but never shorter', async () => {
  assert.equal(MIN_INTERVAL_HOURS, 6);
  const store = new OpportunityStore(':memory:');
  const { source } = harness(store, [() => json(feed([job(1)]))], 1);
  await source.listRecent();
  assert.equal(store.sourceCache.get('remotive')!.nextAttemptAt, new Date(T0 + 6 * HOUR).toISOString(), 'an interval of 1 h is raised to 6 h');

  const longer = new OpportunityStore(':memory:');
  const other = harness(longer, [() => json(feed([job(1)]))], 12);
  await other.source.listRecent();
  assert.equal(longer.sourceCache.get('remotive')!.nextAttemptAt, new Date(T0 + 12 * HOUR).toISOString());
});

test('a job that left the feed is reported as not found, without a request', async () => {
  const store = new OpportunityStore(':memory:');
  const { source, calls } = harness(store, [() => json(feed([job(1)]))]);
  await source.listRecent();
  await assert.rejects(source.fetchDetail('999'), SourceNotFoundError);
  assert.equal(calls.length, 1);
});

// ---------- inside the pipeline ----------
test('in the pipeline: the feed is stored, classified and deduplicated; the second run makes no request', async () => {
  const store = new OpportunityStore(':memory:');
  const jobs = [
    job(1, { job_type: 'freelance', candidate_required_location: 'Worldwide', title: 'React front-end developer' }),
    job(2, { job_type: 'full_time', title: 'React front-end developer' }),
    job(3, { job_type: 'freelance', candidate_required_location: 'USA Only', title: 'React front-end developer' }),
    job(4, { job_type: '', candidate_required_location: 'Worldwide', title: 'React front-end developer' }),
    job(5, { job_type: 'freelance', candidate_required_location: 'Remote', title: 'React front-end developer' }),
    job(6, { job_type: 'internship' }),
    job(7, { job_type: 'contract', title: 'React front-end developer', candidate_required_location: 'Worldwide' }),
    job(8, { job_type: 'freelance', title: 'Freelance Copywriter', category: 'Writing', description: '<p>Write copy for a landing page.</p>' }),
  ];
  const { source, clock, calls } = harness(store, [() => json(feed(jobs))]);
  const options = { source, store, profile: donBrunoProfile, maxPages: 1, targetNew: Number.MAX_SAFE_INTEGER, maxDetailsPerRun: 500, now: () => new Date(clock.now) };

  const first = await runPipeline(options);
  assert.equal(first.newSummaries, 8);
  assert.equal(first.detailsObtained, 8);
  assert.equal(calls.length, 1, 'one request for the whole run, none per job');
  const decision = (id: string) => store.get({ sourceId: 'remotive', externalId: id })!.filter.decision;
  assert.equal(decision('1'), 'shortlist', 'freelance, worldwide, strong skill');
  assert.equal(decision('2'), 'skip', 'full time');
  assert.equal(decision('3'), 'skip', 'excludes residents of Brazil');
  assert.equal(decision('4'), 'review', 'type not stated');
  assert.equal(decision('5'), 'review', 'ambiguous location');
  assert.equal(decision('6'), 'skip', 'internship');
  assert.equal(decision('7'), 'skip', 'a contract is stored but not alerted');
  assert.equal(decision('8'), 'skip', 'a category that is not technology');
  assert.equal(store.get({ sourceId: 'remotive', externalId: '4' })!.opportunity.employmentType, 'unknown', 'never shown as freelance');

  clock.now = T0 + HOUR;
  const second = await runPipeline(options);
  assert.equal(second.alreadyKnown, 8);
  assert.equal(second.newSummaries, 0);
  assert.equal(second.detailsAttempted, 0);
  assert.equal(calls.length, 1, 'the second run used the cache');
  assert.equal(store.count(), 8, 'skipped jobs are stored too, and nothing was stored twice');
});
