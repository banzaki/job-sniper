import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, after, test } from 'node:test';
import { ANALYSIS_VERSION } from '../ai/current-version.js';
import { OpportunityStore } from '../storage/opportunity-store.js';
import { makeAnalysis, makeFilter, makeOpportunity, NOW, SOURCE } from '../testing/fixtures.js';
import { deliverDemo, PRESENTATION } from './deliver.js';
import { NotificationError, type Notifier, type SendOptions } from './notifier.js';
import { TelegramNotifier } from './telegram-notifier.js';

const workDir = mkdtempSync(join(tmpdir(), 'job-sniper-deliver-'));
after(() => rmSync(workDir, { recursive: true, force: true }));

const key = { sourceId: SOURCE, externalId: '1' };

function seeded(path = ':memory:'): OpportunityStore {
  const store = new OpportunityStore(path);
  const opportunity = makeOpportunity('1');
  store.insert(opportunity, makeFilter(), '2026-05-01T00:00:00.000Z');
  store.markNotified(key, '2026-04-30T00:00:00.000Z');
  store.analyses.save(makeAnalysis(opportunity));
  store.analyses.markNotified(key, ANALYSIS_VERSION, '2026-04-30T01:00:00.000Z');
  return store;
}

function recorder(failOn?: (n: number) => Error | null) {
  const sent: { text: string; silent: boolean }[] = [];
  let attempts = 0;
  const notifier: Notifier = {
    send: async (text: string, options: SendOptions = {}) => {
      attempts += 1;
      const failure = failOn?.(attempts);
      if (failure) throw failure;
      sent.push({ text, silent: options.silent === true });
      return { messageId: `m${sent.length}` };
    },
  };
  return { notifier, sent };
}

const demo = (store: OpportunityStore, notifier: Notifier, over: { label?: string; dryRun?: boolean } = {}) =>
  deliverDemo({ store, notifier, key, analysisVersion: ANALYSIS_VERSION, label: over.label ?? 'preview', dryRun: over.dryRun ?? false, now: () => NOW });

test('the demo is delivered once as a separate delivery and leaves every production flag exactly as it was', async () => {
  const store = seeded();
  const before = { opportunity: store.get(key)!.notifiedAt, analysis: store.analyses.get(key, ANALYSIS_VERSION)!.notifiedAt };
  const { notifier, sent } = recorder();

  const first = await demo(store, notifier);
  assert.equal(first.totalParts, 1);
  assert.equal(first.partsSent, 1);
  assert.equal(first.complete, true);
  assert.equal(sent.length, 1, 'one message');
  assert.match(sent[0]!.text, /^🧪 <b>PRÉVIA<\/b> · formato compacto, não é um alerta novo/);
  assert.equal(sent[0]!.silent, false);

  assert.equal(store.get(key)!.notifiedAt, before.opportunity, 'opportunity flag untouched');
  assert.equal(store.analyses.get(key, ANALYSIS_VERSION)!.notifiedAt, before.analysis, 'analysis flag untouched');
  assert.equal(store.analyses.listPendingNotification(ANALYSIS_VERSION).length, 0);
});

test('repeating the same demo confirms zero new parts and sends nothing', async () => {
  const store = seeded();
  const { notifier, sent } = recorder();
  const first = await demo(store, notifier);
  const count = sent.length;

  const second = await demo(store, notifier);
  assert.equal(second.partsSent, 0);
  assert.equal(second.partsAlreadyConfirmed, first.totalParts);
  assert.equal(second.complete, true);
  assert.equal(sent.length, count);
});

test('a different label is a different demo delivery', async () => {
  const store = seeded();
  const { notifier, sent } = recorder();
  await demo(store, notifier, { label: 'a' });
  assert.equal(sent.length, 1);
  await demo(store, notifier, { label: 'b' });
  assert.equal(sent.length, 2);
  assert.equal(store.deliveries.counts().complete, 2);
});

test('a demo that failed before being confirmed is retried after a restart, and only then is it complete', async () => {
  const path = join(workDir, 'demo-restart.db');
  const first = seeded(path);
  const flaky = recorder((n) => (n === 1 ? new NotificationError('lost connection') : null));
  const partial = await demo(first, flaky.notifier);
  assert.equal(partial.partsSent, 0);
  assert.equal(partial.complete, false);
  assert.match(partial.failure?.message ?? '', /lost connection/);
  first.close();

  const reopened = new OpportunityStore(path);
  const healthy = recorder();
  const resumed = await demo(reopened, healthy.notifier);
  assert.equal(resumed.partsAlreadyConfirmed, 0);
  assert.equal(resumed.partsSent, 1);
  assert.equal(healthy.sent.length, 1);
  assert.equal(resumed.complete, true);
  assert.equal((await demo(reopened, healthy.notifier)).partsSent, 0, 'and never again');
  reopened.close();
});

test('a demo made in the former multi-part format does not block the new format, and is never resumed', async () => {
  const store = seeded();
  const old = store.deliveries.create('demo', key, `${ANALYSIS_VERSION}#demo-preview`, 'demo', [
    { label: 'Resumo', content: 'old summary', silent: false },
    { label: 'Detalhes 2/2', content: 'old details', silent: true },
  ], NOW.toISOString());
  store.deliveries.markPartSent(old.id, 1, '1', NOW.toISOString());
  const { notifier, sent } = recorder();

  const report = await demo(store, notifier);
  assert.equal(sent.length, 1);
  assert.ok(!sent.some((message) => /old (summary|details)/.test(message.text)));
  assert.equal(report.complete, true);
  assert.equal(store.deliveries.parts(old.id)[1]?.status, 'pending', 'the old unsent part is not marked as delivered');
});

test('demo in dry-run prints the message but sends, stores and marks nothing', async () => {
  const store = seeded();
  const { notifier, sent } = recorder();
  const report = await demo(store, notifier, { dryRun: true });
  assert.equal(report.rendered, 1);
  assert.equal(sent.length, 1);
  assert.deepEqual(store.deliveries.counts(), { complete: 0, incomplete: 0, partsPending: 0 });
});

test('the demo needs a saved analysis of the current version and never calls a provider', async () => {
  const store = new OpportunityStore(':memory:');
  store.insert(makeOpportunity('1'), makeFilter(), '2026-05-01T00:00:00.000Z');
  await assert.rejects(demo(store, recorder().notifier), /No saved analysis for fake:1/);
});

test('the channel\'s message ids are stored with each confirmed part', async () => {
  const store = seeded();
  const { notifier } = recorder();
  await demo(store, notifier);
  const delivery = store.deliveries.find('demo', key, `${ANALYSIS_VERSION}#demo-${PRESENTATION}-preview`)!;
  const parts = store.deliveries.parts(delivery.id);
  assert.deepEqual(parts.map((part) => part.messageId), parts.map((_, index) => `m${index + 1}`));
  assert.ok(parts.every((part) => part.status === 'sent' && part.sentAt));
});

test('a delivery is unique per kind, opportunity and reference, and completes only when every part is confirmed', () => {
  const store = new OpportunityStore(':memory:');
  const parts = [{ label: 'Resumo', content: 'a', silent: false }, { label: 'Detalhes 2/2', content: 'b', silent: true }];
  const delivery = store.deliveries.create('demo', key, 'ref', 'demo', parts, NOW.toISOString());
  assert.throws(() => store.deliveries.create('demo', key, 'ref', 'demo', parts, NOW.toISOString()), /UNIQUE|constraint/i);
  assert.throws(() => store.deliveries.create('demo', key, 'other', 'demo', [], NOW.toISOString()), /at least one part/);

  store.deliveries.markPartSent(delivery.id, 1, 'x', NOW.toISOString());
  assert.equal(store.deliveries.complete(delivery.id, NOW.toISOString()), false, 'one part is still owed');
  store.deliveries.markPartSent(delivery.id, 1, 'again', NOW.toISOString()); // a confirmed part cannot be re-confirmed
  assert.equal(store.deliveries.parts(delivery.id)[0]?.messageId, 'x');
  store.deliveries.markPartSent(delivery.id, 2, 'y', NOW.toISOString());
  assert.equal(store.deliveries.complete(delivery.id, NOW.toISOString()), true);
  assert.deepEqual(store.deliveries.counts(), { complete: 1, incomplete: 0, partsPending: 0 });
});

// ---------- the Telegram client ----------
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function mockTelegram(respond: (body: Record<string, unknown>) => Response | Promise<Response>) {
  const calls: Record<string, unknown>[] = [];
  globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    calls.push(body);
    return respond(body);
  }) as typeof fetch;
  return calls;
}
const ok = (messageId: number) => new Response(JSON.stringify({ ok: true, result: { message_id: messageId } }), { status: 200 });
const telegram = () => new TelegramNotifier('1234567890:' + 'Q'.repeat(35), '99', { minIntervalMs: 0, timeoutMs: 200 });

test('Telegram: the message id is returned, HTML and the disabled link preview are requested, silence only when asked', async () => {
  const calls = mockTelegram(() => ok(4242));
  const client = telegram();
  const loud = await client.send('<b>oi</b>');
  const quiet = await client.send('<b>oi</b>', { silent: true });
  assert.deepEqual(loud, { messageId: '4242' });
  assert.deepEqual(quiet, { messageId: '4242' });
  assert.equal(calls[0]!.parse_mode, 'HTML');
  assert.deepEqual(calls[0]!.link_preview_options, { is_disabled: true });
  assert.equal(calls[0]!.disable_notification, undefined, 'the summary keeps its sound');
  assert.equal(calls[1]!.disable_notification, true);
});

test('Telegram: the length limit counts characters after parsing, so tags do not count against it', async () => {
  const calls = mockTelegram(() => ok(1));
  const client = telegram();
  const withTags = `<b>${'a'.repeat(4000)}</b>`; // 4007 raw characters, 4000 visible
  await client.send(withTags);
  assert.equal(calls.length, 1);
  await assert.rejects(client.send('a'.repeat(4097)), /Telegram allows 4096/);
  assert.equal(calls.length, 1, 'refused before any request');
});

test('Telegram: a timeout or lost connection is ambiguous, an API refusal is not', async () => {
  mockTelegram(() => Promise.reject(new DOMException('timed out', 'TimeoutError')));
  await assert.rejects(telegram().send('x'), (error: unknown) => error instanceof NotificationError && error.ambiguous && !error.fatal);
  mockTelegram(() => Promise.reject(new TypeError('fetch failed')));
  await assert.rejects(telegram().send('x'), (error: unknown) => error instanceof NotificationError && error.ambiguous);
  mockTelegram(() => new Response(JSON.stringify({ ok: false, description: 'Bad Request: can\'t parse entities' }), { status: 400 }));
  await assert.rejects(telegram().send('x'), (error: unknown) => error instanceof NotificationError && !error.ambiguous && !error.fatal);
  mockTelegram(() => new Response(JSON.stringify({ ok: false, description: 'Unauthorized' }), { status: 401 }));
  await assert.rejects(telegram().send('x'), (error: unknown) => error instanceof NotificationError && error.fatal && !error.ambiguous);
  mockTelegram(() => new Response('<html>gateway</html>', { status: 200 }));
  await assert.rejects(telegram().send('x'), (error: unknown) => error instanceof NotificationError && error.ambiguous, 'a 2xx that cannot be read is unconfirmed');
});

test('Telegram: errors never contain the token', async () => {
  const token = '1234567890:' + 'Q'.repeat(35);
  mockTelegram(() => Promise.reject(new TypeError(`fetch failed for https://api.telegram.org/bot${token}/sendMessage`)));
  await assert.rejects(new TelegramNotifier(token, '1', { minIntervalMs: 0 }).send('x'), (error: unknown) => !(error as Error).message.includes(token));
});
