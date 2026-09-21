import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import { ANALYSIS_VERSION } from '../ai/current-version.js';
import { makeAnalysis, makeFilter, makeOpportunity, SOURCE } from '../testing/fixtures.js';
import { AnalysisDataError } from './analysis-store.js';
import { OpportunityStore } from './opportunity-store.js';

const workDir = mkdtempSync(join(tmpdir(), 'job-sniper-test-'));
after(() => rmSync(workDir, { recursive: true, force: true }));

/** The exact schema and data shape of a database created before AI analyses existed (schema version 1). */
function createVersion1Database(path: string): void {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE opportunities (
      id TEXT PRIMARY KEY, source_id TEXT NOT NULL, external_id TEXT NOT NULL, title TEXT NOT NULL,
      url TEXT NOT NULL, status TEXT NOT NULL, payload_json TEXT NOT NULL,
      first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
      filter_decision TEXT NOT NULL CHECK (filter_decision IN ('shortlist', 'review', 'skip')),
      filter_reasons_json TEXT NOT NULL, filter_keywords_json TEXT NOT NULL,
      filter_evaluated_at TEXT NOT NULL, filter_rule_version TEXT NOT NULL,
      notified_at TEXT, UNIQUE (source_id, external_id)
    );
    PRAGMA user_version = 1;
  `);
  const insert = db.prepare(`INSERT INTO opportunities VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, 'shortlist', '["old reason"]', '["HTML"]', 'e', 'basic-v2', ?)`);
  for (const [id, notifiedAt] of [['1', '2026-03-01T10:00:00.000Z'], ['2', null], ['3', '2026-03-02T10:00:00.000Z']] as const) {
    // Legacy payload: written before the "access" field existed.
    const { access: _ignored, ...legacy } = makeOpportunity(id);
    insert.run(`${SOURCE}:${id}`, SOURCE, id, `T${id}`, `https://x/${id}`, JSON.stringify(legacy), '2026-02-01T00:00:00.000Z', '2026-02-02T00:00:00.000Z', notifiedAt);
  }
  db.close();
}

test('migration from a version-1 database preserves every opportunity, first_seen_at and notified_at', () => {
  const path = join(workDir, 'legacy.db');
  createVersion1Database(path);

  const store = new OpportunityStore(path);
  assert.equal(store.count(), 3);
  const first = store.get({ sourceId: SOURCE, externalId: '1' })!;
  assert.equal(first.notifiedAt, '2026-03-01T10:00:00.000Z');
  assert.equal(first.firstSeenAt, '2026-02-01T00:00:00.000Z');
  assert.equal(first.filter.decision, 'shortlist');
  assert.deepEqual(first.filter.reasons, ['old reason']);
  assert.equal(store.get({ sourceId: SOURCE, externalId: '2' })!.notifiedAt, null);
  assert.equal(store.get({ sourceId: SOURCE, externalId: '3' })!.notifiedAt, '2026-03-02T10:00:00.000Z');
  store.close();

  const check = new DatabaseSync(path, { readOnly: true });
  assert.equal(check.prepare('PRAGMA user_version').get()?.user_version, 3);
  const tables = check.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name);
  for (const table of ['opportunities', 'analyses', 'proposal_drafts', 'discovery_queue', 'deliveries', 'delivery_parts', 'quota_usage', 'quota_state', 'run_locks']) {
    assert.ok(tables.includes(table), table);
  }
  check.close();
});

test('the first upgrade leaves a copy of the version-1 file next to it', () => {
  const path = join(workDir, 'backup.db');
  createVersion1Database(path);
  new OpportunityStore(path).close();

  const backup = join(workDir, 'backup.pre-v3.db');
  assert.ok(existsSync(backup));
  const copy = new DatabaseSync(backup, { readOnly: true });
  assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM opportunities').get()?.n, 3);
  assert.equal(copy.prepare('PRAGMA user_version').get()?.user_version, 1);
  copy.close();
});

test('the migration is idempotent: reopening changes nothing and never overwrites the backup', () => {
  const path = join(workDir, 'idempotent.db');
  createVersion1Database(path);
  const opened = new OpportunityStore(path);
  opened.analyses.save(makeAnalysis(opened.get({ sourceId: SOURCE, externalId: '1' })!.opportunity));
  opened.close();

  for (let round = 0; round < 3; round += 1) {
    const again = new OpportunityStore(path);
    assert.equal(again.count(), 3);
    assert.equal(again.get({ sourceId: SOURCE, externalId: '1' })!.notifiedAt, '2026-03-01T10:00:00.000Z');
    assert.equal(again.analyses.counts(ANALYSIS_VERSION).success, 1, 'analyses survive reopening');
    again.close();
  }
  const backup = new DatabaseSync(join(workDir, 'idempotent.pre-v3.db'), { readOnly: true });
  assert.equal(backup.prepare('PRAGMA user_version').get()?.user_version, 1, 'the backup is the untouched original');
  backup.close();
});

test('opportunities stored before access rules existed read back with unknown access', () => {
  const path = join(workDir, 'access.db');
  createVersion1Database(path);
  const store = new OpportunityStore(path);
  assert.deepEqual(store.get({ sourceId: SOURCE, externalId: '1' })!.opportunity.access, {
    kind: 'unknown',
    publicAt: null,
    rawLabel: null,
  });
  store.close();
});

test('a fresh database is created at version 2 with no backup', () => {
  const path = join(workDir, 'fresh', 'nested', 'new.db');
  const store = new OpportunityStore(path);
  store.insert(makeOpportunity('1'), makeFilter(), '2026-05-01T00:00:00.000Z');
  store.close();
  assert.ok(!existsSync(join(workDir, 'fresh', 'nested', 'new.pre-v3.db')));
  const check = new DatabaseSync(path, { readOnly: true });
  assert.equal(check.prepare('PRAGMA user_version').get()?.user_version, 3);
  check.close();
});

test('a success is never downgraded by a later failure record', () => {
  const store = new OpportunityStore(':memory:');
  const opportunity = makeOpportunity('1');
  store.insert(opportunity, makeFilter(), '2026-05-01T00:00:00.000Z');
  store.analyses.save(makeAnalysis(opportunity));
  store.analyses.recordFailure({
    key: { sourceId: SOURCE, externalId: '1' }, analysisVersion: ANALYSIS_VERSION,
    provider: 'p', model: 'm', message: 'boom', at: '2026-05-02T00:00:00.000Z',
  });
  assert.equal(store.analyses.list(ANALYSIS_VERSION)[0]?.status, 'success');
  assert.ok(store.analyses.get({ sourceId: SOURCE, externalId: '1' }, ANALYSIS_VERSION));
});

test('failures are stored trimmed, counted per attempt, and queryable apart from successes and pending', () => {
  const store = new OpportunityStore(':memory:');
  store.insert(makeOpportunity('1'), makeFilter(), '2026-05-01T00:00:00.000Z');
  store.insert(makeOpportunity('2'), makeFilter(), '2026-05-01T00:00:00.000Z');
  const key = { sourceId: SOURCE, externalId: '1' };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    store.analyses.recordFailure({ key, analysisVersion: ANALYSIS_VERSION, provider: 'p', model: 'm', message: 'x'.repeat(900), at: '2026-05-02T00:00:00.000Z' });
  }
  const [row] = store.analyses.list(ANALYSIS_VERSION, 'failed');
  assert.equal(row?.attempts, 2);
  assert.equal(row?.errorMessage?.length, 500);
  const counts = store.analyses.counts(ANALYSIS_VERSION);
  assert.deepEqual({ pending: counts.pending, success: counts.success, failed: counts.failed }, { pending: 2, success: 0, failed: 1 });
});

test('the proposal draft lives in its own table with its own status', () => {
  const path = join(workDir, 'drafts.db');
  const store = new OpportunityStore(path);
  const opportunity = makeOpportunity('1');
  store.insert(opportunity, makeFilter(), '2026-05-01T00:00:00.000Z');
  store.analyses.save(makeAnalysis(opportunity));
  store.close();

  const db = new DatabaseSync(path, { readOnly: true });
  const draft = db.prepare('SELECT language, body, status FROM proposal_drafts').get();
  assert.equal(draft?.language, 'pt-BR');
  assert.equal(draft?.status, 'draft');
  assert.match(String(draft?.body), /landing page/);
  const analysisRow = db.prepare('SELECT result_json, provider, model FROM analyses').get();
  assert.equal(analysisRow?.provider, 'fake');
  assert.equal(analysisRow?.model, 'fake-model');
  assert.ok(!String(analysisRow?.result_json).includes('proposal'), 'the proposal is not duplicated inside the analysis JSON');
  db.close();
});

test('corrupted stored analysis JSON raises a clear error', () => {
  const path = join(workDir, 'corrupt.db');
  const store = new OpportunityStore(path);
  const opportunity = makeOpportunity('1');
  store.insert(opportunity, makeFilter(), '2026-05-01T00:00:00.000Z');
  store.analyses.save(makeAnalysis(opportunity));
  store.close();

  const db = new DatabaseSync(path);
  db.prepare('UPDATE analyses SET result_json = ?').run('{broken');
  db.close();

  const reopened = new OpportunityStore(path);
  assert.throws(() => reopened.analyses.get({ sourceId: SOURCE, externalId: '1' }, ANALYSIS_VERSION), (error: unknown) => error instanceof AnalysisDataError && /invalid JSON/.test((error as Error).message));
  reopened.close();
});

test('a failure record and the analyses tables never contain secrets: only the given message is stored', () => {
  const store = new OpportunityStore(':memory:');
  store.insert(makeOpportunity('1'), makeFilter(), '2026-05-01T00:00:00.000Z');
  store.analyses.recordFailure({ key: { sourceId: SOURCE, externalId: '1' }, analysisVersion: ANALYSIS_VERSION, provider: 'gemini', model: 'm', message: 'Gemini rejected the request (HTTP 400): [redacted]', at: '2026-05-02T00:00:00.000Z' });
  assert.equal(store.analyses.list(ANALYSIS_VERSION, 'failed')[0]?.errorMessage, 'Gemini rejected the request (HTTP 400): [redacted]');
});
