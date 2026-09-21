import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import { ANALYSIS_SCHEMA } from './analysis-store.js';
import { OpportunityStore } from './opportunity-store.js';
import { makeAnalysis, makeFilter, makeOpportunity, SOURCE } from '../testing/fixtures.js';

const workDir = mkdtempSync(join(tmpdir(), 'job-sniper-mig3-'));
after(() => rmSync(workDir, { recursive: true, force: true }));

/** A database exactly as SPEC 004 left it (schema version 2), with data in every table. */
function createVersion2Database(path: string): void {
  const seedPath = `${path}.seed.db`;
  const seed = new OpportunityStore(seedPath);
  const opportunity = makeOpportunity('1');
  seed.insert(opportunity, makeFilter(), '2026-05-01T00:00:00.000Z');
  seed.markNotified({ sourceId: SOURCE, externalId: '1' }, '2026-05-01T09:00:00.000Z');
  seed.analyses.save(makeAnalysis(opportunity));
  seed.close();

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
  `);
  db.exec(ANALYSIS_SCHEMA);
  const source = new DatabaseSync(seedPath, { readOnly: true });
  for (const table of ['opportunities', 'analyses', 'proposal_drafts']) {
    for (const row of source.prepare(`SELECT * FROM ${table}`).all()) {
      const columns = Object.keys(row);
      db.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`).run(...(Object.values(row) as never[]));
    }
  }
  source.close();
  db.exec('PRAGMA user_version = 2');
  db.close();
  rmSync(seedPath, { force: true });
}

const snapshot = (path: string) => {
  const db = new DatabaseSync(path, { readOnly: true });
  const result = {
    opportunities: JSON.stringify(db.prepare('SELECT * FROM opportunities ORDER BY id').all()),
    analyses: JSON.stringify(db.prepare('SELECT * FROM analyses ORDER BY source_id, external_id, analysis_version').all()),
    drafts: JSON.stringify(db.prepare('SELECT * FROM proposal_drafts ORDER BY source_id, external_id, analysis_version').all()),
  };
  db.close();
  return result;
};

test('upgrading a version-2 database keeps every opportunity, analysis, proposal and notified_at byte for byte', () => {
  const path = join(workDir, 'v2.db');
  createVersion2Database(path);
  const before = snapshot(path);

  const store = new OpportunityStore(path);
  assert.equal(store.get({ sourceId: SOURCE, externalId: '1' })?.notifiedAt, '2026-05-01T09:00:00.000Z');
  assert.deepEqual(store.queue.counts(), { pending: 0, done: 0, unavailable: 0 });
  assert.deepEqual(store.deliveries.counts(), { complete: 0, incomplete: 0, partsPending: 0 });
  store.close();

  assert.deepEqual(snapshot(path), before, 'no existing row changed');
  const check = new DatabaseSync(path, { readOnly: true });
  assert.equal(check.prepare('PRAGMA user_version').get()?.user_version, 4);
  check.close();
});

test('the upgrade leaves a local backup of the version-2 file, which stays untouched', () => {
  const path = join(workDir, 'backup-v2.db');
  createVersion2Database(path);
  const before = snapshot(path);
  new OpportunityStore(path).close();

  const backup = join(workDir, 'backup-v2.pre-v4.db');
  assert.ok(existsSync(backup), 'the backup name ends in .db, which the .gitignore covers');
  assert.deepEqual(snapshot(backup), before);
  const copy = new DatabaseSync(backup, { readOnly: true });
  assert.equal(copy.prepare('PRAGMA user_version').get()?.user_version, 2, 'the backup is still version 2');
  copy.close();
});

test('the migration can be repeated and never overwrites the first backup', () => {
  const path = join(workDir, 'repeat.db');
  createVersion2Database(path);
  new OpportunityStore(path).close();
  const opened = new OpportunityStore(path);
  opened.queue.upsertDiscovered({ sourceId: SOURCE, externalId: '5', title: 'T', url: 'https://x/5', summary: null, publishedAt: null, discoveredAt: 'd' }, '2026-05-02T00:00:00.000Z');
  opened.close();

  for (let round = 0; round < 3; round += 1) {
    const again = new OpportunityStore(path);
    assert.equal(again.count(), 1);
    assert.equal(again.queue.counts().pending, 1, 'work added after the upgrade survives reopening');
    again.close();
  }
  const backup = new DatabaseSync(join(workDir, 'repeat.pre-v4.db'), { readOnly: true });
  assert.equal(backup.prepare('PRAGMA user_version').get()?.user_version, 2);
  backup.close();
});
