import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigError, loadAiConfig, loadConfig, requireGeminiKey, requireTelegramCredentials } from './config.js';

const quiet = (): void => {};

test('run limits default to 20 pages, 100 new summaries and 20 details (independent, none promises full coverage)', () => {
  const config = loadConfig({}, quiet);
  assert.equal(config.discoveryMaxPages, 20);
  assert.equal(config.discoveryTargetNew, 100);
  assert.equal(config.maxDetailsPerRun, 20);
});

test('blank discovery settings fall back to the defaults', () => {
  const config = loadConfig({ DISCOVERY_MAX_PAGES: '  ', DISCOVERY_TARGET_NEW: '' }, quiet);
  assert.equal(config.discoveryMaxPages, 20);
  assert.equal(config.discoveryTargetNew, 100);
});

test('valid discovery settings are used', () => {
  const config = loadConfig({ DISCOVERY_MAX_PAGES: ' 3 ', DISCOVERY_TARGET_NEW: '25' }, quiet);
  assert.equal(config.discoveryMaxPages, 3);
  assert.equal(config.discoveryTargetNew, 25);
});

for (const name of ['DISCOVERY_MAX_PAGES', 'DISCOVERY_TARGET_NEW']) {
  for (const bad of ['0', '-1', '1.5', 'abc', '1e3', '0x10', '99999999999999999999']) {
    test(`${name}="${bad}" is rejected with a clear error naming the variable`, () => {
      assert.throws(
        () => loadConfig({ [name]: bad }, quiet),
        (error: unknown) => error instanceof ConfigError && error.message.includes(name) && error.message.includes('positive integer'),
      );
    });
  }
}

test('MAX_DETAILS_PER_RUN keeps its warn-and-fall-back behavior', () => {
  const warnings: string[] = [];
  const config = loadConfig({ MAX_DETAILS_PER_RUN: 'abc' }, (message) => warnings.push(message));
  assert.equal(config.maxDetailsPerRun, 20);
  assert.equal(warnings.length, 1);
});

test('AI is disabled by default with the documented defaults', () => {
  const ai = loadAiConfig({}, quiet);
  assert.equal(ai.enabled, false);
  assert.equal(ai.provider, 'gemini');
  assert.equal(ai.model, 'gemini-3.6-flash');
  assert.equal(ai.maxAnalysesPerRun, 20);
  assert.equal(ai.apiKey, null);
});

test('AI configuration never breaks anything while AI is disabled, whatever else is set', () => {
  const ai = loadAiConfig({ AI_PROVIDER: 'nonsense', AI_MAX_ANALYSES_PER_RUN: 'abc', AI_ENABLED: 'false' }, quiet);
  assert.equal(ai.enabled, false);
  assert.doesNotThrow(() => loadConfig({ AI_PROVIDER: 'nonsense', AI_MAX_ANALYSES_PER_RUN: '999', AI_ENABLED: 'maybe' }, quiet));
});

test('an invalid AI_ENABLED value warns and keeps AI disabled', () => {
  const warnings: string[] = [];
  assert.equal(loadAiConfig({ AI_ENABLED: 'yes' }, (message) => warnings.push(message)).enabled, false);
  assert.equal(warnings.length, 1);
});

test('enabled AI accepts the intended operating values', () => {
  const ai = loadAiConfig(
    { AI_ENABLED: 'true', AI_PROVIDER: 'Gemini', AI_MODEL: ' gemini-3.6-flash ', AI_MAX_ANALYSES_PER_RUN: '20', GEMINI_API_KEY: ' k ' },
    quiet,
  );
  assert.deepEqual(ai, {
    enabled: true, provider: 'gemini', model: 'gemini-3.6-flash', apiKey: 'k',
    maxAnalysesPerRun: 20, minIntervalSeconds: 15, maxRequestsPerDay: 20,
  });
});

test('the Gemini pacing and daily limits are configurable, validated only when AI is enabled', () => {
  const ai = loadAiConfig({ AI_ENABLED: 'true', GEMINI_MIN_INTERVAL_SECONDS: '30', GEMINI_MAX_REQUESTS_PER_DAY: '15' }, quiet);
  assert.equal(ai.minIntervalSeconds, 30);
  assert.equal(ai.maxRequestsPerDay, 15);
  for (const name of ['GEMINI_MIN_INTERVAL_SECONDS', 'GEMINI_MAX_REQUESTS_PER_DAY']) {
    assert.throws(() => loadAiConfig({ AI_ENABLED: 'true', [name]: '0' }, quiet), (error: unknown) => error instanceof ConfigError && error.message.includes(name));
  }
  assert.doesNotThrow(() => loadAiConfig({ GEMINI_MIN_INTERVAL_SECONDS: 'abc' }, quiet));
});

for (const bad of ['0', '-1', '21', '1.5', 'abc', '100']) {
  test(`AI_MAX_ANALYSES_PER_RUN="${bad}" is rejected when AI is enabled`, () => {
    assert.throws(
      () => loadAiConfig({ AI_ENABLED: 'true', AI_MAX_ANALYSES_PER_RUN: bad }, quiet),
      (error: unknown) => error instanceof ConfigError && error.message.includes('AI_MAX_ANALYSES_PER_RUN'),
    );
  });
}

test('an unsupported provider is rejected when AI is enabled (no automatic provider fallback)', () => {
  assert.throws(() => loadAiConfig({ AI_ENABLED: 'true', AI_PROVIDER: 'openai' }, quiet), (error: unknown) => error instanceof ConfigError && /not supported/.test((error as Error).message));
});

test('the Gemini key is required only when needed, and errors never echo values', () => {
  const missing = loadAiConfig({ AI_ENABLED: 'true' }, quiet);
  assert.throws(() => requireGeminiKey(missing), (error: unknown) => error instanceof ConfigError && /GEMINI_API_KEY/.test((error as Error).message));
  assert.equal(requireGeminiKey(loadAiConfig({ AI_ENABLED: 'true', GEMINI_API_KEY: 'secret-value' }, quiet)), 'secret-value');
});

test('a malformed Telegram token is rejected with a clear error that reports only counts, never the value', () => {
  // Built at run time so no token-shaped literal sits in the source.
  const secret = ['1234567890', '1234567890', 'Q'.repeat(35)].join(':');
  const config = loadConfig({ TELEGRAM_BOT_TOKEN: secret, TELEGRAM_CHAT_ID: '5' }, quiet);
  assert.throws(
    () => requireTelegramCredentials(config),
    (error: unknown) =>
      error instanceof ConfigError &&
      /TELEGRAM_BOT_TOKEN has an unexpected format/.test(error.message) &&
      /3 colon-separated part/.test(error.message) &&
      !error.message.includes('QQQQQ') &&
      !error.message.includes('1234567890'),
  );
});

test('well-formed Telegram tokens are accepted', () => {
  const token = ['1234567890', 'Q'.repeat(35)].join(':');
  assert.deepEqual(requireTelegramCredentials(loadConfig({ TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: '5' }, quiet)), { botToken: token, chatId: '5' });
});
