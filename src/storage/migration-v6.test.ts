import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import { makeAnalysis, makeFilter, makeOpportunity, SOURCE } from '../testing/fixtures.js';
import { OpportunityStore } from './opportunity-store.js';

const workDir = mkdtempSync(join(tmpdir(), 'job-sniper-mig6-'));
after(() => rmSync(workDir, { recursive: true, force: true }));

/** A database as version 5 left it: top_match accepted, exchange rates, no alert queue; rows with data and a delivery flag. */
function createVersion5Database(path: string): void {
  const store = new OpportunityStore(path);
  const one = makeOpportunity('1', { sourceId: 'freelancer', budget: { currency: 'INR', kind: 'fixed', min: 600, max: 1500 }, fetchedAt: '2026-09-21T10:00:00.000Z', sourceMetadata: { exchangeRateToUsd: 0.0104 } });
  const plain = makeOpportunity('2');
  store.insert(one, { ...makeFilter('shortlist'), decision: 'top_match' }, '2026-09-21T09:00:00.000Z');
  store.insert(plain, makeFilter('review'), '2026-09-21T09:00:00.000Z');
  store.markNotified({ sourceId: SOURCE, externalId: '2' }, '2026-09-21T09:30:00.000Z');
  store.analyses.save(makeAnalysis(plain));
  store.close();
  const db = new DatabaseSync(path);
  db.exec('DROP TABLE alert_queue');
  db.exec('PRAGMA user_version = 5');
  db.close();
}

const snapshot = (path: string) => {
  const db = new DatabaseSync(path, { readOnly: true });
  const tables = ['opportunities', 'analyses', 'proposal_drafts', 'discovery_queue', 'deliveries', 'delivery_parts', 'source_cache', 'exchange_rates'];
  const result = Object.fromEntries(tables.map((table) => [table, JSON.stringify(db.prepare(`SELECT * FROM ${table} ORDER BY 1, 2`).all())]));
  db.close();
  return result;
};

test('upgrading a version-5 database adds only the alert queue: every row stays byte for byte and nothing becomes selected', () => {
  const path = join(workDir, 'v5.db');
  createVersion5Database(path);
  const before = snapshot(path);

  const store = new OpportunityStore(path);
  assert.deepEqual(store.alertQueue.counts(), { selected: 0, overflow: 0, expired: 0 }, 'an existing backlog is not selected by the upgrade');
  assert.equal(store.get({ sourceId: SOURCE, externalId: '2' })?.notifiedAt, '2026-09-21T09:30:00.000Z');
  assert.deepEqual(store.alertQueue.listBacklog(['top_match', 'shortlist', 'review']).map((key) => key.externalId), ['1'], 'the undelivered row is backlog, not an alert');
  store.close();

  assert.deepEqual(snapshot(path), before);
  const check = new DatabaseSync(path, { readOnly: true });
  assert.equal(check.prepare('PRAGMA user_version').get()?.user_version, 6);
  const tables = check.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => String(row.name));
  assert.ok(tables.includes('alert_queue'));
  check.close();
});

test('the version-5 file is backed up once as pre-v6, untouched, and reopening changes nothing', () => {
  const path = join(workDir, 'v5b.db');
  createVersion5Database(path);
  const original = snapshot(path);
  new OpportunityStore(path).close();

  const backup = join(workDir, 'v5b.pre-v6.db');
  assert.ok(existsSync(backup));
  const copy = new DatabaseSync(backup, { readOnly: true });
  assert.equal(copy.prepare('PRAGMA user_version').get()?.user_version, 5, 'the backup is still version 5');
  assert.equal(copy.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'alert_queue'").get()?.n, 0);
  copy.close();
  assert.deepEqual(snapshot(backup), original);

  const afterFirst = snapshot(path);
  new OpportunityStore(path).close();
  assert.deepEqual(snapshot(path), afterFirst, 'the second opening changes nothing');
  assert.deepEqual(snapshot(backup), original, 'the backup is never overwritten');
});

test('the alert queue keeps no delivery flag of its own and refuses an unknown status', () => {
  const store = new OpportunityStore(':memory:');
  store.insert(makeOpportunity('1'), makeFilter('shortlist'), '2026-09-21T09:00:00.000Z');
  const key = { sourceId: SOURCE, externalId: '1' };
  store.alertQueue.record('batch-1', '2026-09-21T09:01:00.000Z', [{ key, status: 'selected', rank: 1, decision: 'shortlist' }]);
  assert.equal(store.alertQueue.get(key)?.status, 'selected');
  assert.equal(store.get(key)?.notifiedAt, null, 'selecting never marks a delivery');
  store.alertQueue.record('batch-2', '2026-09-21T10:00:00.000Z', [{ key, status: 'overflow', rank: 9, decision: 'shortlist' }]);
  assert.equal(store.alertQueue.get(key)?.batchId, 'batch-1', 'an opportunity is considered once: the first record stands');
  const raw = (store as unknown as { db: DatabaseSync }).db;
  assert.throws(() => raw.exec("INSERT INTO alert_queue VALUES ('a', 'b', 'c', 'sent', 1, 'shortlist', 'x')"), /CHECK/);
  store.close();
});
