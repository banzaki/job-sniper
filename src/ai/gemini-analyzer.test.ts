import assert from 'node:assert/strict';
import { test } from 'node:test';
import { brunoCandidate } from '../profile/bruno-candidate.js';
import { makeOpportunity, validModelOutput } from '../testing/fixtures.js';
import {
  AnalysisInvalidOutputError,
  AnalysisQuotaError,
  AnalysisRejectedError,
  AnalysisUnavailableError,
} from './errors.js';
import { GeminiAnalyzer } from './gemini-analyzer.js';

const KEY = 'fake-test-key-not-a-real-secret-0123456789';
const MODEL = 'gemini-3.6-flash';

interface Call {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const okBody = (text: string, extra: Record<string, unknown> = {}) => ({
  candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }],
  modelVersion: 'gemini-3.6-flash-001',
  ...extra,
});

function analyzerWith(responses: (() => Response | Promise<Response>)[]) {
  const calls: Call[] = [];
  let index = 0;
  const fakeFetch = (async (url: unknown, init: RequestInit) => {
    calls.push({
      url: String(url),
      headers: init.headers as Record<string, string>,
      body: JSON.parse(String(init.body)) as Record<string, unknown>,
    });
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return next!();
  }) as typeof fetch;
  const analyzer = new GeminiAnalyzer(KEY, MODEL, { fetch: fakeFetch, minIntervalMs: 0, retryDelayMs: 0, timeoutMs: 500 });
  return { analyzer, calls };
}

const input = () => ({ opportunity: makeOpportunity('1'), candidate: brunoCandidate });
const goodText = () => JSON.stringify(validModelOutput());

test('a valid response becomes an analysis carrying provider, configured model and the reported model version', async () => {
  const { analyzer, calls } = analyzerWith([() => json(200, okBody(goodText()))]);
  const analysis = await analyzer.analyze(input());
  assert.equal(analysis.provider, 'gemini');
  assert.equal(analysis.model, MODEL);
  assert.equal(analysis.modelVersion, 'gemini-3.6-flash-001');
  assert.equal(analysis.score, 82);
  assert.equal(calls.length, 1);
});

test('the request uses one model, the key only in a header, JSON output, and no tools or grounding', async () => {
  const { analyzer, calls } = analyzerWith([() => json(200, okBody(goodText()))]);
  await analyzer.analyze(input());
  const call = calls[0]!;
  assert.equal(call.url, `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`);
  assert.ok(!call.url.includes(KEY), 'the key must never be in the URL');
  assert.equal(call.headers['x-goog-api-key'], KEY);
  assert.equal((call.body.generationConfig as Record<string, unknown>).responseMimeType, 'application/json');
  for (const forbidden of ['tools', 'toolConfig', 'googleSearch', 'googleSearchRetrieval', 'safetySettings']) {
    assert.equal(call.body[forbidden], undefined, `${forbidden} must not be sent`);
  }
  assert.ok(!JSON.stringify(call.body).includes(KEY), 'the key must never be in the body');
});

test('HTTP 429 is quota exhaustion: reported as such and never retried', async () => {
  const { analyzer, calls } = analyzerWith([() => json(429, { error: { message: 'Quota exceeded' } })]);
  await assert.rejects(analyzer.analyze(input()), (error: unknown) => error instanceof AnalysisQuotaError && /429/.test((error as Error).message));
  assert.equal(calls.length, 1);
});

test('a transient failure is retried exactly once and then succeeds', async () => {
  const { analyzer, calls } = analyzerWith([() => json(503, { error: { message: 'overloaded' } }), () => json(200, okBody(goodText()))]);
  const analysis = await analyzer.analyze(input());
  assert.equal(analysis.score, 82);
  assert.equal(calls.length, 2);
});

test('retry is bounded: two transient failures in a row give up, never a third call', async () => {
  const { analyzer, calls } = analyzerWith([() => json(500, {}), () => json(502, {}), () => json(200, okBody(goodText()))]);
  await assert.rejects(analyzer.analyze(input()), (error: unknown) => error instanceof AnalysisUnavailableError);
  assert.equal(calls.length, 2);
});

test('a timeout is transient: one retry, then AnalysisUnavailableError', async () => {
  const timeout = () => Promise.reject(new DOMException('The operation timed out', 'TimeoutError'));
  const { analyzer, calls } = analyzerWith([timeout]);
  await assert.rejects(analyzer.analyze(input()), (error: unknown) => error instanceof AnalysisUnavailableError && /timed out/.test((error as Error).message));
  assert.equal(calls.length, 2);
});

test('a network error is transient and its message is scrubbed of the key', async () => {
  const failing = () => Promise.reject(new TypeError(`fetch failed: https://x/?key=${KEY}`));
  const { analyzer } = analyzerWith([failing]);
  await assert.rejects(analyzer.analyze(input()), (error: unknown) => {
    const message = (error as Error).message;
    return error instanceof AnalysisUnavailableError && !message.includes(KEY) && message.includes('[redacted]');
  });
});

for (const status of [400, 401, 403, 404]) {
  test(`HTTP ${status} is a rejected request: not retried, key scrubbed from the message`, async () => {
    const { analyzer, calls } = analyzerWith([() => json(status, { error: { message: `bad request for key ${KEY}` } })]);
    await assert.rejects(analyzer.analyze(input()), (error: unknown) => {
      const message = (error as Error).message;
      return error instanceof AnalysisRejectedError && !message.includes(KEY) && message.includes(String(status));
    });
    assert.equal(calls.length, 1);
  });
}

test('unusable answers are invalid output, not transient: no retry', async () => {
  const cases: (() => Response)[] = [
    () => json(200, okBody('this is not JSON')),
    () => json(200, okBody(JSON.stringify(validModelOutput({ score: 250 })))),
    () => json(200, { candidates: [], promptFeedback: { blockReason: 'SAFETY' } }),
    () => json(200, { candidates: [{ content: { parts: [{ text: '{"score":' }] }, finishReason: 'MAX_TOKENS' }] }),
    () => json(200, { candidates: [{ content: { parts: [] }, finishReason: 'STOP' }] }),
  ];
  for (const respond of cases) {
    const { analyzer, calls } = analyzerWith([respond]);
    await assert.rejects(analyzer.analyze(input()), (error: unknown) => error instanceof AnalysisInvalidOutputError);
    assert.equal(calls.length, 1);
  }
});

test('no fallback: every call, including the retry, targets the same single model on the same host', async () => {
  const { analyzer, calls } = analyzerWith([() => json(500, {}), () => json(500, {})]);
  await assert.rejects(analyzer.analyze(input()));
  await assert.rejects(analyzer.analyze(input()));
  assert.equal(calls.length, 4);
  assert.deepEqual(new Set(calls.map((call) => call.url)).size, 1);
  assert.ok(calls.every((call) => call.url.includes(`/models/${MODEL}:`)));
});

test('a proposal that breaks the truthfulness rules is rejected even when the JSON is well formed', async () => {
  const dishonest = validModelOutput({ proposalText: 'Sou especialista com 8 anos de experiência.' });
  const { analyzer } = analyzerWith([() => json(200, okBody(JSON.stringify(dishonest)))]);
  await assert.rejects(analyzer.analyze(input()), (error: unknown) => error instanceof AnalysisInvalidOutputError);
});

test('stats expose the request count and the last HTTP status, never headers or the key', async () => {
  const { analyzer } = analyzerWith([() => json(503, { error: { message: 'busy.' } }), () => json(503, { error: { message: 'busy.' } })]);
  assert.deepEqual({ ...analyzer.stats }, { requests: 0, lastStatus: null });
  await assert.rejects(analyzer.analyze(input()), (error: unknown) => error instanceof AnalysisUnavailableError && /\(HTTP 503\): busy\.$/.test((error as Error).message));
  assert.deepEqual({ ...analyzer.stats }, { requests: 2, lastStatus: 503 });

  const ok = analyzerWith([() => json(200, okBody(goodText()))]);
  await ok.analyzer.analyze(input());
  assert.deepEqual({ ...ok.analyzer.stats }, { requests: 1, lastStatus: 200 });
  assert.ok(!JSON.stringify(ok.analyzer.stats).includes(KEY));
});
