import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import { analysisVersionFor } from '../ai/analyzer.js';
import { ANALYSIS_VERSION } from '../ai/current-version.js';
import type { Opportunity } from '../domain/opportunity.js';
import { brunoCandidate } from '../profile/bruno-candidate.js';
import { makeAnalysis, makeFilter, makeOpportunity, NOW, SOURCE } from '../testing/fixtures.js';
import { OpportunityStore } from './opportunity-store.js';

const workDir = mkdtempSync(join(tmpdir(), 'job-sniper-supersede-'));
after(() => rmSync(workDir, { recursive: true, force: true }));

const key = { sourceId: SOURCE, externalId: '1' };
const OLD_VERSION = 'ai-v1';

function seeded(): { store: OpportunityStore; opportunity: Opportunity } {
  const store = new OpportunityStore(':memory:');
  const opportunity = makeOpportunity('1');
  store.insert(opportunity, makeFilter(), '2026-05-01T00:00:00.000Z');
  return { store, opportunity };
}

/** An analysis produced under the previous, provisional-but-"confirmed" profile. */
const oldAnalysis = (opportunity: Opportunity) => ({ ...makeAnalysis(opportunity), analysisVersion: OLD_VERSION });

test('a relevant profile change makes the opportunity eligible again, while the earlier result stays as history', () => {
  const { store, opportunity } = seeded();
  const oldVersion = analysisVersionFor(brunoCandidate);
  store.analyses.save({ ...makeAnalysis(opportunity), analysisVersion: oldVersion });
  assert.equal(store.analyses.select(oldVersion, { limit: 20 }).totalEligible, 0);

  const promoted = { ...brunoCandidate, skills: brunoCandidate.skills.map((s) => (s.name === 'HTML' ? { ...s, level: 'confirmed' as const } : s)) };
  const newVersion = analysisVersionFor(promoted);
  assert.notEqual(newVersion, oldVersion);
  assert.equal(store.analyses.select(newVersion, { limit: 20 }).totalEligible, 1, 'eligible again with the same prompt');

  store.analyses.save({ ...makeAnalysis(opportunity, { score: 61 }), analysisVersion: newVersion });
  assert.equal(store.analyses.get(key, oldVersion)?.analysis.score, 82, 'the old result is preserved');
  assert.equal(store.analyses.get(key, newVersion)?.analysis.score, 61);
  assert.equal(store.analyses.list(oldVersion).length + store.analyses.list(newVersion).length, 2);
});

test('discardSuperseded marks old drafts "discarded" and keeps every analysis and proposal text as history', () => {
  const { store, opportunity } = seeded();
  store.analyses.save(oldAnalysis(opportunity));
  const before = store.analyses.get(key, OLD_VERSION)!;
  assert.equal(before.analysis.proposal.status, 'draft');

  assert.equal(store.analyses.discardSuperseded(ANALYSIS_VERSION, '2026-05-02T00:00:00.000Z'), 1);
  const after = store.analyses.get(key, OLD_VERSION)!;
  assert.equal(after.analysis.proposal.status, 'discarded');
  assert.equal(after.analysis.proposal.text, before.analysis.proposal.text, 'the text is preserved');
  assert.equal(after.analysis.score, before.analysis.score);
  assert.equal(store.analyses.countSuperseded(ANALYSIS_VERSION), 1);
});

test('discardSuperseded is idempotent and never touches the current version', () => {
  const { store, opportunity } = seeded();
  store.analyses.save(makeAnalysis(opportunity));
  assert.equal(store.analyses.discardSuperseded(ANALYSIS_VERSION, '2026-05-02T00:00:00.000Z'), 0);
  assert.equal(store.analyses.get(key, ANALYSIS_VERSION)?.analysis.proposal.status, 'draft');

  store.analyses.save(oldAnalysis(opportunity));
  assert.equal(store.analyses.discardSuperseded(ANALYSIS_VERSION, '2026-05-02T00:00:00.000Z'), 1);
  assert.equal(store.analyses.discardSuperseded(ANALYSIS_VERSION, '2026-05-03T00:00:00.000Z'), 0);
});

test('an approved or submitted proposal from an older version is never altered', () => {
  const path = join(workDir, 'approved.db');
  const store = new OpportunityStore(path);
  store.insert(makeOpportunity('1'), makeFilter(), '2026-05-01T00:00:00.000Z');
  store.analyses.save(oldAnalysis(makeOpportunity('1')));
  store.close();

  const db = new DatabaseSync(path);
  db.prepare("UPDATE proposal_drafts SET status = 'approved'").run();
  db.close();

  const reopened = new OpportunityStore(path);
  assert.equal(reopened.analyses.discardSuperseded(ANALYSIS_VERSION, '2026-05-02T00:00:00.000Z'), 0);
  assert.equal(reopened.analyses.get(key, OLD_VERSION)?.analysis.proposal.status, 'approved');
  reopened.close();
});

test('a superseded analysis is never announced', () => {
  const { store, opportunity } = seeded();
  store.analyses.save(oldAnalysis(opportunity));
  assert.deepEqual(store.analyses.listPendingNotification(ANALYSIS_VERSION), []);
});

test('an analysis stored before skill verification existed reads back as unverified', () => {
  const path = join(workDir, 'legacy-analysis.db');
  const store = new OpportunityStore(path);
  store.insert(makeOpportunity('1'), makeFilter(), '2026-05-01T00:00:00.000Z');
  store.analyses.save(oldAnalysis(makeOpportunity('1')));
  store.close();

  const db = new DatabaseSync(path);
  db.prepare("UPDATE analyses SET result_json = json_remove(result_json, '$.verification')").run();
  db.close();

  const reopened = new OpportunityStore(path);
  const legacy = reopened.analyses.get(key, OLD_VERSION)!.analysis;
  assert.equal(legacy.verification.status, 'unverified');
  assert.match(legacy.verification.note ?? '', /before skill verification existed/);
  reopened.close();
});

test('updateAccess replaces only the access information and records when it was checked', () => {
  const path = join(workDir, 'access.db');
  const store = new OpportunityStore(path);
  store.insert(makeOpportunity('1', { access: { kind: 'unknown', publicAt: null, rawLabel: null } }), makeFilter('shortlist'), '2026-05-01T00:00:00.000Z');
  store.markNotified(key, '2026-05-01T09:00:00.000Z');
  const before = store.get(key)!;

  const changed = store.updateAccess(
    key,
    { kind: 'premium_only', publicAt: '2026-05-02T12:00:00.000Z', rawLabel: 'Projeto Exclusivo. Ficará disponível para todos os profissionais em 23h52m30s.' },
    '2026-05-01T12:00:00.000Z',
  );
  assert.equal(changed, true);

  const after = store.get(key)!;
  assert.equal(after.opportunity.access.kind, 'premium_only');
  assert.equal(after.opportunity.access.publicAt, '2026-05-02T12:00:00.000Z');
  assert.equal(after.opportunity.sourceMetadata.accessCheckedAt, '2026-05-01T12:00:00.000Z');
  assert.deepEqual({ ...after.opportunity, access: before.opportunity.access, sourceMetadata: {} }, { ...before.opportunity, sourceMetadata: {} }, 'no other opportunity field changed');
  assert.deepEqual(after.filter, before.filter);
  assert.equal(after.firstSeenAt, before.firstSeenAt);
  assert.equal(after.notifiedAt, '2026-05-01T09:00:00.000Z');
  assert.equal(store.updateAccess({ sourceId: SOURCE, externalId: 'missing' }, after.opportunity.access, NOW.toISOString()), false);
  store.close();
});
