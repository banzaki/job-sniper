import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigError, loadConfig } from './config.js';

const quiet = (): void => {};

test('discovery settings default to 5 pages and 10 unseen opportunities', () => {
  const config = loadConfig({}, quiet);
  assert.equal(config.discoveryMaxPages, 5);
  assert.equal(config.discoveryTargetNew, 10);
});

test('blank discovery settings fall back to the defaults', () => {
  const config = loadConfig({ DISCOVERY_MAX_PAGES: '  ', DISCOVERY_TARGET_NEW: '' }, quiet);
  assert.equal(config.discoveryMaxPages, 5);
  assert.equal(config.discoveryTargetNew, 10);
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
  assert.equal(config.maxDetailsPerRun, 10);
  assert.equal(warnings.length, 1);
});
