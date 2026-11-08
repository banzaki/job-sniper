import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import type { FilterDecision, FilterResult } from '../domain/filter-result.js';
import type { OpportunityKey } from '../domain/opportunity.js';
import { selectAlertBatch } from '../pipeline/select-alert-batch.js';
import { OpportunityStore } from '../storage/opportunity-store.js';
import { makeOpportunity } from '../testing/fixtures.js';
import { dailyAllowance } from './daily-limit.js';
import { deliverManual, previewManual } from './manual.js';
import { assertSendAllowed, parseManualArgs, SEND_BLOCKED_MESSAGE } from './manual-args.js';
import type { Notifier } from './notifier.js';
import { notifyPending } from './notify-pending.js';
import { SOURCE_LABELS } from './source-labels.js';

const USAGE = 'Usage: test';
const T0 = '2026-09-21T15:00:00.000Z';
const NOW = new Date('2026-09-21T15:05:00.000Z');
const ALL: readonly FilterDecision[] = ['top_match', 'shortlist', 'review'];
const MAX_AGE = { freelancer: 24 };

let counter = 0;
function add(store: OpportunityStore, decision: FilterDecision = 'shortlist', over: Parameters<typeof makeOpportunity>[1] = {}): OpportunityKey {
  counter += 1;
  const opportunity = makeOpportunity(`m${counter}`, { sourceId: 'freelancer', title: `Project m${counter}`, employmentType: 'freelance', proposalCount: 10, publishedAt: T0, fetchedAt: T0, ...over });
  const filter: FilterResult = { decision, reasons: ['strong signals: HTML'], matchedKeywords: ['HTML'], evaluatedAt: T0, ruleVersion: 'basic-v10' };
  store.insert(opportunity, filter, T0);
  return { sourceId: opportunity.sourceId, externalId: opportunity.externalId };
}
function sender(fail = false) {
  const sent: string[] = [];
  const notifier: Notifier = {
    send: async (text) => {
      if (fail) throw new Error('telegram down');
      sent.push(text);
      return { messageId: `m${sent.length}` };
    },
  };
  return { notifier, sent };
}
/** Fills the automatic day: `n` alerts that a collection selected and Telegram confirmed. */
function fillAutomaticDay(store: OpportunityStore, n: number): void {
  for (let i = 0; i < n; i += 1) {
    const key = add(store, 'shortlist');
    store.alertQueue.record(`batch-${i}`, T0, [{ key, status: 'selected', rank: 1, decision: 'shortlist' }]);
    store.markNotified(key, T0);
  }
}
const base = (store: OpportunityStore, key: OpportunityKey, notifier: Notifier, send: boolean) => ({
  store,
  notifier,
  key,
  send,
  format: { sourceLabels: SOURCE_LABELS, now: NOW },
  now: () => NOW,
  maxAgeHoursBySource: MAX_AGE,
});

// ---------- arguments ----------
test('the manual commands take exactly one source:id and never an implicit batch', () => {
  assert.deepEqual(parseManualArgs(['--only', 'freelancer:40725242', '--send'], USAGE), { key: { sourceId: 'freelancer', externalId: '40725242' }, send: true });
  assert.deepEqual(parseManualArgs(['--only', 'freelancer:40725242'], USAGE).send, false, 'no --send: only rendered');
  assert.equal(parseManualArgs(['--send', '--only', '99freelas:abc:def'], USAGE).key.externalId, 'abc:def');
  const bad: string[][] = [
    [],
    ['--send'],
    ['--only'],
    ['--only', ''],
    ['--only', 'all'],
    ['--only', 'ALL', '--send'],
    ['--only', 'todos'],
    ['--only', '*'],
    ['--only', 'freelancer:1,freelancer:2'],
    ['--only', 'freelancer:1 freelancer:2'],
    ['--only', 'freelancer:1', '--only', 'freelancer:2'],
    ['--only', 'freelancer'],
    ['--only', ':1'],
    ['--only', 'freelancer:'],
    ['--only', 'freelancer:1', '--send', '--send'],
    ['--only', 'freelancer:1', '--limit', '3'],
    ['--all'],
  ];
  for (const argv of bad) assert.throws(() => parseManualArgs(argv, USAGE), Error, JSON.stringify(argv));
});

// ---------- manual preview ----------
test('a manual preview has its own header, is repeatable, and touches nothing of production', async () => {
  const store = new OpportunityStore(':memory:');
  const key = add(store);
  fillAutomaticDay(store, 10); // the automatic day is full
  const queueBefore = store.alertQueue.counts();
  const sink = sender();

  for (let i = 0; i < 3; i += 1) {
    const report = await previewManual({ ...base(store, key, sink.notifier, true) });
    assert.equal(report.sent, true);
  }
  assert.equal(sink.sent.length, 3, 'repeatable any number of times, even with the day full');
  for (const text of sink.sent) {
    assert.ok(text.includes('🧪 PRÉVIA MANUAL'), 'mandatory header');
    assert.ok(!text.includes('NOVA OPORTUNIDADE'));
  }
  assert.equal(store.get(key)?.notifiedAt, null, 'notified_at untouched');
  assert.deepEqual(store.alertQueue.counts(), queueBefore, 'the alert queue is untouched');
  assert.equal(store.alertQueue.get(key), null, 'not even an entry was created');
  assert.equal(store.deliveries.find('analysis', key, 'v#c1'), null, 'no production delivery');

  const allowance = dailyAllowance(store, NOW, 10);
  assert.equal(allowance.manualPreviews, 3, 'counted as previews');
  assert.equal(allowance.automaticToday, 10);
  assert.equal(allowance.manualDeliveries, 0);
  assert.equal(allowance.remaining, 0, 'the automatic limit is what it was');
});

test('a manual preview without --send only renders: nothing is sent, stored or marked', async () => {
  const store = new OpportunityStore(':memory:');
  const key = add(store);
  const sink = sender();
  const printed: string[] = [];
  const report = await previewManual({ ...base(store, key, sink.notifier, false), print: (text) => printed.push(text) });
  assert.equal(report.sent, false);
  assert.equal(sink.sent.length, 0);
  assert.equal(printed.length, 1);
  assert.ok(printed[0]!.includes('🧪 PRÉVIA MANUAL'));
  assert.equal(dailyAllowance(store, NOW, 10).manualPreviews, 0, 'nothing was stored');
});

test('a manual preview can show any stored opportunity, a delivered one and one with old data (with a warning), but not one that does not exist', async () => {
  const store = new OpportunityStore(':memory:');
  const delivered = add(store);
  store.markNotified(delivered, T0);
  const old = add(store, 'review', { fetchedAt: '2026-09-19T00:00:00.000Z' });
  const sink = sender();
  assert.equal((await previewManual({ ...base(store, delivered, sink.notifier, true) })).sent, true);
  const stale = await previewManual({ ...base(store, old, sink.notifier, true) });
  assert.equal(stale.sent, true);
  assert.equal(stale.staleData, true);
  assert.equal(store.get(delivered)?.notifiedAt, T0, 'the historical delivery time is not changed');
  await assert.rejects(previewManual({ ...base(store, { sourceId: 'freelancer', externalId: 'nope' }, sink.notifier, true) }), /No stored opportunity/);
});

test('a failed preview is reported and still leaves production untouched', async () => {
  const store = new OpportunityStore(':memory:');
  const key = add(store);
  const report = await previewManual({ ...base(store, key, sender(true).notifier, true) });
  assert.equal(report.sent, false);
  assert.match(report.failure?.message ?? '', /telegram down/);
  assert.equal(store.get(key)?.notifiedAt, null);
  assert.equal(dailyAllowance(store, NOW, 10).manualPreviews, 0, 'an unconfirmed preview is not counted');
});

// ---------- manual real delivery ----------
test('a manual delivery ignores only the automatic daily limit: it is sent with the day full, recorded, and counted as manual', async () => {
  const store = new OpportunityStore(':memory:');
  fillAutomaticDay(store, 10);
  const key = add(store);
  const sink = sender();
  const report = await deliverManual({ ...base(store, key, sink.notifier, true), decisions: ALL, dailyCap: 10 });
  assert.equal(report.outcome, 'sent');
  assert.equal(sink.sent.length, 1);
  assert.ok(sink.sent[0]!.includes('NOVA OPORTUNIDADE'), 'a real alert, not a preview');
  assert.equal(store.get(key)?.notifiedAt, NOW.toISOString(), 'notified_at is written after confirmation');
  assert.equal(report.daily?.automaticToday, 10);
  assert.equal(report.daily?.manualDeliveries, 1);
  assert.equal(report.daily?.manualPreviews, 0);
  assert.equal(report.daily?.remaining, 0, 'it did not consume (or refund) the automatic limit');
});

test('a manual delivery is never repeated: an already delivered one points to the preview', async () => {
  const store = new OpportunityStore(':memory:');
  const key = add(store);
  const sink = sender();
  assert.equal((await deliverManual({ ...base(store, key, sink.notifier, true), decisions: ALL })).outcome, 'sent');
  const again = await deliverManual({ ...base(store, key, sink.notifier, true), decisions: ALL });
  assert.equal(again.outcome, 'refused');
  assert.match(again.reason ?? '', /notify:preview/);
  assert.equal(sink.sent.length, 1, 'nothing was sent the second time');
});

test('a manual delivery still validates the decision, the link, the content, the freshness and the existence', async () => {
  const store = new OpportunityStore(':memory:');
  const sink = sender();
  const attempt = async (key: OpportunityKey) => deliverManual({ ...base(store, key, sink.notifier, true), decisions: ALL });

  assert.match((await attempt(add(store, 'skip'))).reason ?? '', /not deliverable/);
  assert.match((await attempt(add(store, 'shortlist', { url: 'javascript:alert(1)' }))).reason ?? '', /valid http/);
  assert.match((await attempt(add(store, 'shortlist', { url: '' }))).reason ?? '', /valid http/);
  assert.match((await attempt(add(store, 'shortlist', { title: '   ' }))).reason ?? '', /no title/);
  assert.match((await attempt(add(store, 'shortlist', { fetchedAt: '2026-09-19T00:00:00.000Z' }))).reason ?? '', /older than 24 hours/);
  assert.match((await attempt({ sourceId: 'freelancer', externalId: 'nope' })).reason ?? '', /No stored opportunity/);
  assert.equal(sink.sent.length, 0, 'none of them was sent');
});

test('a manual delivery without --send only renders; a failure leaves it undelivered and out of the count', async () => {
  const store = new OpportunityStore(':memory:');
  const key = add(store);
  const sink = sender();
  const dry = await deliverManual({ ...base(store, key, sink.notifier, false), decisions: ALL, dailyCap: 10 });
  assert.equal(dry.outcome, 'rendered');
  assert.equal(sink.sent.length, 0);
  assert.equal(store.get(key)?.notifiedAt, null);

  const failed = await deliverManual({ ...base(store, key, sender(true).notifier, true), decisions: ALL, dailyCap: 10 });
  assert.equal(failed.outcome, 'failed');
  assert.match(failed.reason ?? '', /telegram down/);
  assert.equal(store.get(key)?.notifiedAt, null, 'not marked without a confirmation');
  assert.equal(failed.daily?.manualDeliveries, 0);
});

test('a manual delivery of an alert a collection already selected takes it out of the automatic count, and the queue entry is otherwise kept', async () => {
  const store = new OpportunityStore(':memory:');
  const key = add(store);
  store.alertQueue.record('batch-1', T0, [{ key, status: 'selected', rank: 1, decision: 'shortlist' }]);
  const report = await deliverManual({ ...base(store, key, sender().notifier, true), decisions: ALL, dailyCap: 10 });
  assert.equal(report.outcome, 'sent');
  assert.equal(report.daily?.automaticToday, 0);
  assert.equal(report.daily?.manualDeliveries, 1);
  assert.equal(store.alertQueue.get(key)?.status, 'selected');
  assert.equal(store.alertQueue.listSelectedPending(ALL).length, 0, 'delivered: no longer owed');
});

// ---------- the automatic path stays governed ----------
test('the automatic path still obeys the daily limit, counting only its own alerts, and keeps what it selected', async () => {
  const store = new OpportunityStore(':memory:');
  fillAutomaticDay(store, 8);
  // Manual use today must not reduce the two places left for automatic alerts.
  const manualKey = add(store);
  await deliverManual({ ...base(store, manualKey, sender().notifier, true), decisions: ALL });
  await previewManual({ ...base(store, manualKey, sender().notifier, true) });

  for (let i = 0; i < 5; i += 1) add(store, 'shortlist', { proposalCount: 5 + i });
  const batch = selectAlertBatch(store, { batchId: T0, decisions: ALL, cap: 5, dailyCap: 10, now: NOW });
  assert.equal(batch.daily?.automaticToday, 8);
  assert.equal(batch.daily?.remaining, 2, 'manual delivery and preview did not consume it');
  assert.equal(batch.selected.length, 2);

  const sink = sender();
  const report = await notifyPending({
    store,
    notifier: sink.notifier,
    decisions: ALL,
    dryRun: false,
    format: { sourceLabels: SOURCE_LABELS, now: NOW },
    now: () => NOW,
    maxAlerts: 5,
    maxAlertsPerDay: 10,
    alertKeys: batch.alertKeys,
  });
  assert.equal(report.sent, 2);
  assert.equal(dailyAllowance(store, NOW, 10).automaticToday, 10);
  const third = await notifyPending({ store, notifier: sink.notifier, decisions: ALL, dryRun: false, format: { sourceLabels: SOURCE_LABELS, now: NOW }, now: () => NOW, maxAlerts: 5, maxAlertsPerDay: 10, alertKeys: batch.alertKeys });
  assert.equal(third.sent, 0, 'the day is full for automatic alerts');
});

// ---------- DRY_RUN=true blocks every external send ----------
const REPO = fileURLToPath(new URL('../../', import.meta.url));

test('--send with DRY_RUN=true is blocked with a clear message; --send with DRY_RUN=false passes the guard', () => {
  assert.throws(() => assertSendAllowed(true, true), (error: unknown) => error instanceof Error && error.message === SEND_BLOCKED_MESSAGE);
  assert.equal(SEND_BLOCKED_MESSAGE, 'Envio bloqueado: DRY_RUN=true. Defina DRY_RUN=false para autorizar envio real.');
  assert.doesNotThrow(() => assertSendAllowed(true, false), '--send + DRY_RUN=false is allowed (credentials are checked next)');
  assert.doesNotThrow(() => assertSendAllowed(false, true), 'without --send nothing is sent, so DRY_RUN is irrelevant');
  assert.doesNotThrow(() => assertSendAllowed(false, false));
});

/** Runs a real CLI in a child process against its own database, with DRY_RUN set explicitly and no Telegram credentials. */
function runCli(script: string, args: string[], dbPath: string, dryRun: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_PATH: dbPath, DRY_RUN: dryRun, TELEGRAM_BOT_TOKEN: '', TELEGRAM_CHAT_ID: '', GEMINI_API_KEY: '', AI_ENABLED: 'false' };
  return spawnSync(process.execPath, ['--import', 'tsx', `src/cli/${script}.ts`, ...args], { cwd: REPO, env, encoding: 'utf8' });
}

for (const script of ['notify-preview', 'notify-manual']) {
  test(`${script} --send with DRY_RUN=true fails before Telegram and leaves the database byte-for-byte unchanged`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'job-sniper-dry-'));
    try {
      const dbPath = join(dir, 'guard.db');
      const store = new OpportunityStore(dbPath);
      // These CLI subprocesses use the real wall clock. Keep the fixture fresh
      // so this guard test does not fail for unrelated source-age policy.
      const fresh = new Date().toISOString();
      const key = add(store, 'shortlist', { publishedAt: fresh, fetchedAt: fresh });
      store.close();
      const before = createHash('sha256').update(readFileSync(dbPath)).digest('hex');
      const id = `${key.sourceId}:${key.externalId}`;

      const blocked = runCli(script, ['--only', id, '--send'], dbPath, 'true');
      assert.equal(blocked.status, 1, blocked.stdout + blocked.stderr);
      assert.ok(blocked.stderr.includes('Envio bloqueado: DRY_RUN=true. Defina DRY_RUN=false para autorizar envio real.'), blocked.stderr);
      assert.ok(!/Telegram|credentials|Missing/i.test(blocked.stdout + blocked.stderr.replace(/Envio bloqueado[^\n]*/, '')), 'it failed on DRY_RUN, not on credentials or a Telegram call');
      assert.equal(createHash('sha256').update(readFileSync(dbPath)).digest('hex'), before, 'the database file was not touched');

      // Without --send it only renders, whatever DRY_RUN says, and still marks nothing.
      for (const dryRun of ['true', 'false']) {
        const rendered = runCli(script, ['--only', id], dbPath, dryRun);
        assert.equal(rendered.status, 0, rendered.stdout + rendered.stderr);
        assert.ok(rendered.stdout.includes('Nothing was sent, stored or marked.'));
        if (script === 'notify-preview') assert.ok(rendered.stdout.includes('🧪 PRÉVIA MANUAL'));
      }
      const reopened = new OpportunityStore(dbPath);
      assert.equal(reopened.get(key)?.notifiedAt, null, 'notified_at untouched');
      assert.deepEqual(reopened.alertQueue.counts(), { selected: 0, overflow: 0, expired: 0 }, 'the queue is untouched');
      const usage = dailyAllowance(reopened, new Date(), 10);
      assert.equal(usage.manualPreviews + usage.manualDeliveries + usage.automaticToday, 0, 'no counter moved');
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
