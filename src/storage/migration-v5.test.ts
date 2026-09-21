import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import { makeAnalysis, makeFilter, makeOpportunity, NOW, SOURCE } from '../testing/fixtures.js';
import { OpportunityStore } from './opportunity-store.js';

const workDir = mkdtempSync(join(tmpdir(), 'job-sniper-mig5-'));
after(() => rmSync(workDir, { recursive: true, force: true }));

const OLD_TABLE = `
CREATE TABLE opportunities (
  id TEXT PRIMARY KEY, source_id TEXT NOT NULL, external_id TEXT NOT NULL, title TEXT NOT NULL, url TEXT NOT NULL,
  status TEXT NOT NULL, payload_json TEXT NOT NULL, first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
  filter_decision TEXT NOT NULL CHECK (filter_decision IN ('shortlist', 'review', 'skip')),
  filter_reasons_json TEXT NOT NULL, filter_keywords_json TEXT NOT NULL, filter_evaluated_at TEXT NOT NULL,
  filter_rule_version TEXT NOT NULL, notified_at TEXT, UNIQUE (source_id, external_id)
);`;

/** A database as version 4 left it: three accepted decisions, no exchange_rates table, rows with data and a delivery flag. */
function createVersion4Database(path: string): void {
  const store = new OpportunityStore(path);
  const inr = makeOpportunity('1', { sourceId: 'freelancer', budget: { currency: 'INR', kind: 'fixed', min: 600, max: 1500 }, fetchedAt: '2026-09-21T10:00:00.000Z', sourceMetadata: { exchangeRateToUsd: 0.0104 } });
  const newerInr = makeOpportunity('2', { sourceId: 'freelancer', budget: { currency: 'INR', kind: 'fixed', min: 1, max: 2 }, fetchedAt: '2026-09-21T12:00:00.000Z', sourceMetadata: { exchangeRateToUsd: 0.0105 } });
  const eur = makeOpportunity('3', { sourceId: 'freelancer', budget: { currency: 'EUR', kind: 'hourly', min: 10, max: 20 }, fetchedAt: '2026-09-21T11:00:00.000Z', sourceMetadata: { exchangeRateToUsd: 1.15 } });
  const noRate = makeOpportunity('4', { sourceId: 'freelancer', budget: { currency: 'GBP', kind: 'fixed', min: 5, max: 9 } });
  const plain = makeOpportunity('5');
  for (const [opportunity, decision] of [[inr, 'shortlist'], [newerInr, 'review'], [eur, 'skip'], [noRate, 'review'], [plain, 'shortlist']] as const) {
    store.insert(opportunity, makeFilter(decision), '2026-09-21T09:00:00.000Z');
  }
  store.markNotified({ sourceId: SOURCE, externalId: '5' }, '2026-09-21T09:30:00.000Z');
  store.analyses.save(makeAnalysis(plain));
  store.close();

  const db = new DatabaseSync(path);
  db.exec('DROP TABLE exchange_rates');
  db.exec('DROP TABLE alert_queue');
  db.exec('ALTER TABLE opportunities RENAME TO opportunities_new');
  db.exec(OLD_TABLE);
  db.exec('INSERT INTO opportunities SELECT * FROM opportunities_new');
  db.exec('DROP TABLE opportunities_new');
  db.exec('PRAGMA user_version = 4');
  db.close();
}

const snapshot = (path: string) => {
  const db = new DatabaseSync(path, { readOnly: true });
  const tables = ['opportunities', 'analyses', 'proposal_drafts', 'discovery_queue', 'deliveries', 'delivery_parts', 'source_cache'];
  const result = Object.fromEntries(tables.map((table) => [table, JSON.stringify(db.prepare(`SELECT * FROM ${table} ORDER BY 1, 2`).all())]));
  db.close();
  return result;
};

test('upgrading a version-4 database accepts top_match, keeps every row byte for byte and seeds the rates from stored rows', () => {
  const path = join(workDir, 'v4.db');
  createVersion4Database(path);
  const before = snapshot(path);

  // Control: the old table really refuses the new decision.
  const old = new DatabaseSync(path);
  assert.throws(() => old.exec("UPDATE opportunities SET filter_decision = 'top_match' WHERE external_id = '1'"), /CHECK/);
  old.close();

  const store = new OpportunityStore(path);
  assert.equal(store.get({ sourceId: SOURCE, externalId: '5' })?.notifiedAt, '2026-09-21T09:30:00.000Z', 'delivery flag kept');
  assert.equal(store.count(), 5);
  // The new decision is accepted, on an existing row and on a new one.
  const key = { sourceId: 'freelancer', externalId: '1' };
  store.updateFilters([{ key, filter: { ...makeFilter('shortlist'), decision: 'top_match' } }]);
  assert.equal(store.get(key)?.filter.decision, 'top_match');
  store.insert(makeOpportunity('9'), { ...makeFilter('shortlist'), decision: 'top_match' }, '2026-09-21T13:00:00.000Z');
  assert.equal(store.get({ sourceId: SOURCE, externalId: '9' })?.filter.decision, 'top_match');
  // The newest rate per source and currency, dated by its own collection time; a currency without a rate is absent.
  assert.deepEqual(store.exchangeRates.lookup('freelancer', 'INR'), { rateToUsd: 0.0105, observedAt: '2026-09-21T12:00:00.000Z' });
  assert.deepEqual(store.exchangeRates.lookup('freelancer', 'eur'), { rateToUsd: 1.15, observedAt: '2026-09-21T11:00:00.000Z' });
  assert.equal(store.exchangeRates.lookup('freelancer', 'GBP'), null);
  store.close();

  const check = new DatabaseSync(path, { readOnly: true });
  assert.equal(check.prepare('PRAGMA user_version').get()?.user_version, 6);
  check.close();

  // Undo the two deliberate writes above: everything else must still be exactly what version 4 had.
  const restore = new DatabaseSync(path);
  restore.exec("DELETE FROM opportunities WHERE external_id = '9' AND source_id = 'fake'");
  restore.exec("UPDATE opportunities SET filter_decision = 'shortlist', filter_reasons_json = (SELECT filter_reasons_json FROM opportunities WHERE external_id = '2'), filter_keywords_json = (SELECT filter_keywords_json FROM opportunities WHERE external_id = '2'), filter_evaluated_at = (SELECT filter_evaluated_at FROM opportunities WHERE external_id = '2'), filter_rule_version = (SELECT filter_rule_version FROM opportunities WHERE external_id = '2') WHERE external_id = '1'");
  restore.close();
  assert.deepEqual(snapshot(path), before);
});

test('the version-4 file is backed up once as pre-v6, untouched, and reopening changes nothing', () => {
  const path = join(workDir, 'v4b.db');
  createVersion4Database(path);
  const original = snapshot(path);
  new OpportunityStore(path).close();

  const backup = join(workDir, 'v4b.pre-v6.db');
  assert.ok(existsSync(backup));
  const copy = new DatabaseSync(backup, { readOnly: true });
  assert.equal(copy.prepare('PRAGMA user_version').get()?.user_version, 4, 'the backup is still version 4');
  assert.equal(copy.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'exchange_rates'").get()?.n, 0);
  copy.close();
  assert.deepEqual(snapshot(backup), original, 'the backup holds exactly the original rows');

  const afterFirst = snapshot(path);
  new OpportunityStore(path).close();
  assert.deepEqual(snapshot(path), afterFirst, 'the second opening changes nothing');
  assert.deepEqual(snapshot(backup), original, 'the backup is never overwritten');
});

test('a fresh database is created directly at version 6, accepts top_match and needs no backup', () => {
  const path = join(workDir, 'fresh.db');
  const store = new OpportunityStore(path);
  store.insert(makeOpportunity('1'), { ...makeFilter('shortlist'), decision: 'top_match' }, NOW.toISOString());
  assert.equal(store.get({ sourceId: SOURCE, externalId: '1' })?.filter.decision, 'top_match');
  assert.deepEqual(store.listPendingNotification(['top_match']), [{ sourceId: SOURCE, externalId: '1' }]);
  assert.deepEqual(store.listPendingNotification(['shortlist', 'review']), []);
  store.close();
  assert.ok(!existsSync(join(workDir, 'fresh.pre-v6.db')));
});

test('the exchange-rate cache keeps the newest observation per source and currency and ignores unusable data', () => {
  const store = new OpportunityStore(':memory:');
  const rates = store.exchangeRates;
  rates.record('freelancer', 'inr', 0.0104, '2026-09-21T10:00:00.000Z');
  rates.record('freelancer', 'INR', 0.0105, '2026-09-21T12:00:00.000Z');
  rates.record('freelancer', 'INR', 0.0099, '2026-09-21T08:00:00.000Z'); // older: ignored
  assert.deepEqual(rates.lookup('freelancer', 'INR'), { rateToUsd: 0.0105, observedAt: '2026-09-21T12:00:00.000Z' });
  assert.equal(rates.lookup('other-source', 'INR'), null, 'a rate belongs to the source that published it');
  for (const [code, rate, at] of [['', 1, '2026-09-21T12:00:00Z'], ['EUR', 0, '2026-09-21T12:00:00Z'], ['EUR', -1, '2026-09-21T12:00:00Z'], ['EUR', Number.NaN, '2026-09-21T12:00:00Z'], ['EUR', 1.1, 'not a date']] as const) {
    rates.record('freelancer', code, rate, at);
  }
  assert.equal(rates.lookup('freelancer', 'EUR'), null);
  store.close();
});
