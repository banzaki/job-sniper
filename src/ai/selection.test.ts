import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FilterResult } from '../domain/filter-result.js';
import type { Opportunity } from '../domain/opportunity.js';
import { brunoCandidate } from '../profile/bruno-candidate.js';
import { SKILL_ALIASES } from '../profile/skill-aliases.js';
import { OpportunityStore } from '../storage/opportunity-store.js';
import { makeAnalysis, makeOpportunity, NOW, SOURCE } from '../testing/fixtures.js';
import { analysisVersionFor, profileFingerprint } from './analyzer.js';
import { standingOf } from './analysis-output.js';
import { ANALYSIS_VERSION } from './current-version.js';

const filterOf = (decision: FilterResult['decision'], keywords: string[] = ['HTML']): FilterResult => ({
  decision,
  reasons: ['r'],
  matchedKeywords: keywords,
  evaluatedAt: NOW.toISOString(),
  ruleVersion: 'basic-v2',
});

interface Row {
  id: string;
  decision?: FilterResult['decision'];
  keywords?: string[];
  published: string;
  firstSeen?: string;
  over?: Partial<Opportunity>;
}

function storeWith(rows: Row[]): OpportunityStore {
  const store = new OpportunityStore(':memory:');
  for (const row of rows) {
    store.insert(
      makeOpportunity(row.id, { publishedAt: row.published, ...row.over }),
      filterOf(row.decision ?? 'shortlist', row.keywords ?? ['HTML']),
      row.firstSeen ?? '2026-04-01T00:00:00.000Z',
    );
  }
  return store;
}

const ids = (store: OpportunityStore, limit = 50, options: { force?: boolean; only?: { sourceId: string; externalId: string } } = {}) =>
  store.analyses.select(ANALYSIS_VERSION, { limit, ...options }).keys.map((key) => key.externalId);

test('basic-filter skips are kept out of automatic analysis, counted apart, and can still be picked explicitly by id', () => {
  const store = storeWith([
    { id: '1', decision: 'shortlist', published: '2026-04-05T00:00:00.000Z' },
    { id: '2', decision: 'skip', keywords: [], published: '2026-04-06T00:00:00.000Z' },
    { id: '3', decision: 'review', published: '2026-04-04T00:00:00.000Z' },
  ]);
  assert.deepEqual(ids(store).sort(), ['1', '3']);
  const counts = store.analyses.counts(ANALYSIS_VERSION);
  assert.equal(counts.pending, 2);
  assert.equal(counts.keptAside, 1);
  // Explicit selection reviews a discard, still respecting status.
  assert.deepEqual(ids(store, 5, { only: { sourceId: SOURCE, externalId: '2' } }), ['2']);
  assert.deepEqual(ids(storeWith([{ id: '9', decision: 'skip', published: '2026-04-06T00:00:00.000Z', over: { status: 'cancelled' } }]), 5, { only: { sourceId: SOURCE, externalId: '9' } }), []);
});

test('a basic skip is not an AI skip: analyzing one by id stores the AI\'s own conclusion separately', () => {
  const store = storeWith([{ id: '2', decision: 'skip', keywords: [], published: '2026-04-06T00:00:00.000Z' }]);
  store.analyses.save(makeAnalysis(store.get({ sourceId: SOURCE, externalId: '2' })!.opportunity, { recommendation: 'review' }, NOW, brunoCandidate));
  assert.equal(store.get({ sourceId: SOURCE, externalId: '2' })!.filter.decision, 'skip');
  assert.equal(store.analyses.get({ sourceId: SOURCE, externalId: '2' }, ANALYSIS_VERSION)!.analysis.recommendation, 'review');
});

test('shortlist comes before review, and matched keywords before none', () => {
  const store = storeWith([
    { id: 'review-kw', decision: 'review', keywords: ['API'], published: '2026-04-09T00:00:00.000Z' },
    { id: 'short-none', decision: 'shortlist', keywords: [], published: '2026-04-01T00:00:00.000Z' },
    { id: 'short-kw', decision: 'shortlist', keywords: ['HTML'], published: '2026-04-02T00:00:00.000Z' },
    { id: 'review-none', decision: 'review', keywords: [], published: '2026-04-10T00:00:00.000Z' },
  ]);
  assert.deepEqual(ids(store), ['short-kw', 'short-none', 'review-kw', 'review-none']);
});

test('inside a group, the most recent alternates with the one waiting longest, so old items advance too', () => {
  const rows: Row[] = Array.from({ length: 6 }, (_, i) => ({
    id: String(i + 1),
    published: `2026-04-0${i + 1}T00:00:00.000Z`, // 6 is the newest
    firstSeen: `2026-04-0${i + 1}T00:00:00.000Z`, // 1 has waited longest
  }));
  assert.deepEqual(ids(storeWith(rows)), ['6', '1', '5', '2', '4', '3']);
  assert.deepEqual(ids(storeWith(rows), 2), ['6', '1']);
});

test('category, premium access and unverified competence never exclude a vague opportunity by themselves', () => {
  const store = storeWith([
    { id: '1', published: '2026-04-01T00:00:00.000Z', over: { category: 'Vendas & Marketing', access: { kind: 'premium_only', publicAt: null, rawLabel: 'x' } } },
    { id: '2', published: '2026-04-02T00:00:00.000Z', over: { category: 'Design & Criação' } },
  ]);
  assert.deepEqual(ids(store).sort(), ['1', '2']);
});

test('a failed analysis is retried automatically at most 3 times, after fresh items, and stays visible', () => {
  const store = storeWith([
    { id: 'fresh', published: '2026-04-01T00:00:00.000Z' },
    { id: 'failed-once', published: '2026-04-09T00:00:00.000Z' },
    { id: 'failed-thrice', published: '2026-04-08T00:00:00.000Z' },
  ]);
  const fail = (id: string, times: number) => {
    for (let i = 0; i < times; i += 1) {
      store.analyses.recordFailure({ key: { sourceId: SOURCE, externalId: id }, analysisVersion: ANALYSIS_VERSION, provider: 'p', model: 'm', message: 'rejected', at: '2026-04-10T00:00:00.000Z' });
    }
  };
  fail('failed-once', 1);
  fail('failed-thrice', 3);

  assert.deepEqual(ids(store), ['fresh', 'failed-once'], 'the newer failure waits behind the fresh item; the exhausted one is not picked');
  const counts = store.analyses.counts(ANALYSIS_VERSION);
  assert.equal(counts.failed, 2);
  assert.equal(counts.exhausted, 1);
  assert.equal(store.analyses.list(ANALYSIS_VERSION, 'failed').length, 2, 'both remain visible as failed');
  // An explicit request may still retry the exhausted one.
  assert.deepEqual(ids(store, 5, { only: { sourceId: SOURCE, externalId: 'failed-thrice' } }), ['failed-thrice']);
});

test('the same rejections cannot monopolize the next batch: fresh items come first', () => {
  const rows: Row[] = Array.from({ length: 6 }, (_, i) => ({ id: `n${i}`, published: `2026-04-0${i + 1}T00:00:00.000Z` }));
  rows.push({ id: 'bad1', published: '2026-04-20T00:00:00.000Z' }, { id: 'bad2', published: '2026-04-21T00:00:00.000Z' });
  const store = storeWith(rows);
  for (const id of ['bad1', 'bad2']) {
    store.analyses.recordFailure({ key: { sourceId: SOURCE, externalId: id }, analysisVersion: ANALYSIS_VERSION, provider: 'p', model: 'm', message: 'x', at: '2026-04-22T00:00:00.000Z' });
  }
  const batch = ids(store, 6);
  assert.ok(!batch.includes('bad1') && !batch.includes('bad2'));
  assert.equal(batch.length, 6);
});

test('a known alias is recognized without changing the level: unverified stays unverified', () => {
  assert.deepEqual(SKILL_ALIASES['responsive layouts']?.includes('design responsivo'), true);
  for (const name of ['design responsivo', 'layouts responsivos', 'responsive layouts', 'Responsive Design']) {
    assert.equal(standingOf(name, brunoCandidate), 'unverified', name);
  }
  assert.equal(standingOf('otimização de performance', brunoCandidate), 'notCovered');
  assert.equal(standingOf('React Native', brunoCandidate), 'notCovered', 'an unavailable skill is never rescued by aliasing');
});

test('adding aliases leaves the profile, its fingerprint and every stored analysis valid', () => {
  const skill = brunoCandidate.skills.find((entry) => entry.name === 'responsive layouts');
  assert.equal(skill?.level, 'unverified');
  assert.equal(skill?.aliases, undefined, 'the profile itself was not edited');
  assert.equal(brunoCandidate.skills.filter((entry) => entry.level === 'confirmed').length, 0);
  assert.equal(analysisVersionFor(brunoCandidate), ANALYSIS_VERSION);
  assert.match(profileFingerprint(brunoCandidate), /^[0-9a-f]{8}$/);
});

test('historic analyses are preserved when the selection changes', () => {
  const store = storeWith([{ id: '1', published: '2026-04-01T00:00:00.000Z' }]);
  const old = { ...makeAnalysis(store.get({ sourceId: SOURCE, externalId: '1' })!.opportunity), analysisVersion: 'ai-v1' };
  store.analyses.save(old);
  assert.deepEqual(ids(store), ['1'], 'still pending for the current version');
  assert.ok(store.analyses.get({ sourceId: SOURCE, externalId: '1' }, 'ai-v1'), 'the old result is untouched');
});
