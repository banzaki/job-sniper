import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import { makeAnalysis, makeFilter, makeOpportunity, SOURCE } from '../testing/fixtures.js';
import { OpportunityStore } from './opportunity-store.js';
import { SCHEMA_V3 } from './schema-v3.js';

const workDir = mkdtempSync(join(tmpdir(), 'job-sniper-mig4-'));
after(() => rmSync(workDir, { recursive: true, force: true }));

/** A database as SPEC 005 left it: schema version 3, with data, queue and a delivery. */
function createVersion3Database(path: string): void {
  const store = new OpportunityStore(path);
  const opportunity = makeOpportunity('1');
  store.insert(opportunity, makeFilter(), '2026-05-01T00:00:00.000Z');
  store.markNotified({ sourceId: SOURCE, externalId: '1' }, '2026-05-01T09:00:00.000Z');
  store.analyses.save(makeAnalysis(opportunity));
  store.queue.upsertDiscovered({ sourceId: SOURCE, externalId: '2', title: 't', url: 'https://x/2', summary: null, publishedAt: null, discoveredAt: 'd' }, '2026-05-01T00:00:00.000Z');
  store.close();
  // Return the file to what SPEC 005 produced: no source_cache table, user_version 3.
  const db = new DatabaseSync(path);
  db.exec('DROP TABLE source_cache');
  db.exec('PRAGMA user_version = 3');
  db.close();
}

const snapshot = (path: string) => {
  const db = new DatabaseSync(path, { readOnly: true });
  const tables = ['opportunities', 'analyses', 'proposal_drafts', 'discovery_queue', 'deliveries', 'delivery_parts'];
  const result = Object.fromEntries(tables.map((table) => [table, JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all())]));
  db.close();
  return result;
};

test('upgrading a version-3 database adds only the source cache and leaves every existing row byte for byte', () => {
  const path = join(workDir, 'v3.db');
  createVersion3Database(path);
  const before = snapshot(path);

  const store = new OpportunityStore(path);
  assert.equal(store.sourceCache.get('remotive'), null, 'the new table exists and is empty');
  assert.equal(store.get({ sourceId: SOURCE, externalId: '1' })?.notifiedAt, '2026-05-01T09:00:00.000Z');
  store.close();

  assert.deepEqual(snapshot(path), before);
  const check = new DatabaseSync(path, { readOnly: true });
  assert.equal(check.prepare('PRAGMA user_version').get()?.user_version, 6);
  const tables = check.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => String(row.name));
  assert.ok(tables.includes('source_cache'));
  check.close();
});

test('the upgrade leaves a backup of the version-3 file, untouched, and never overwrites it on later openings', () => {
  const path = join(workDir, 'v3b.db');
  createVersion3Database(path);
  new OpportunityStore(path).close();

  const backup = join(workDir, 'v3b.pre-v6.db');
  assert.ok(existsSync(backup));
  const copy = new DatabaseSync(backup, { readOnly: true });
  assert.equal(copy.prepare('PRAGMA user_version').get()?.user_version, 3, 'the backup is still version 3');
  assert.equal(copy.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'source_cache'").get()?.n, 0);
  copy.close();

  const again = new OpportunityStore(path);
  again.sourceCache.beginAttempt('remotive', 'a', 'b');
  again.close();
  const repeat = new DatabaseSync(backup, { readOnly: true });
  assert.equal(repeat.prepare('PRAGMA user_version').get()?.user_version, 3, 'still the original');
  repeat.close();
  assert.ok(SCHEMA_V3.length > 0);
});

test('the cache entry keeps the response, the attempt clock and the failure count across reopening', () => {
  const path = join(workDir, 'cache.db');
  const first = new OpportunityStore(path);
  first.sourceCache.beginAttempt('remotive', '2026-09-21T12:00:00.000Z', '2026-09-21T18:00:00.000Z');
  first.sourceCache.recordSuccess('remotive', '{"jobs":[]}', '2026-09-21T12:00:00.000Z', '2026-09-21T18:00:00.000Z');
  first.sourceCache.beginAttempt('remotive', '2026-09-21T18:00:00.000Z', '2026-09-22T00:00:00.000Z');
  first.sourceCache.recordFailure('remotive', '2026-09-21T18:00:00.000Z', 'x'.repeat(900), '2026-09-22T00:00:00.000Z');
  first.close();

  const reopened = new OpportunityStore(path);
  const entry = reopened.sourceCache.get('remotive')!;
  reopened.close();
  assert.equal(entry.payloadJson, '{"jobs":[]}', 'a failure keeps the last good response');
  assert.equal(entry.fetchedAt, '2026-09-21T12:00:00.000Z');
  assert.equal(entry.lastAttemptAt, '2026-09-21T18:00:00.000Z');
  assert.equal(entry.nextAttemptAt, '2026-09-22T00:00:00.000Z');
  assert.equal(entry.attempts, 2);
  assert.equal(entry.consecutiveFailures, 1);
  assert.equal(entry.lastError!.length, 500, 'the stored error is bounded');
});
