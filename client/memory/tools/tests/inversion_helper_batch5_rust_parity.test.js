#!/usr/bin/env node
'use strict';

const path = require('path');
const assert = require('assert');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const inversionPath = path.join(REPO_ROOT, 'systems', 'autonomy', 'inversion_controller.js');
const bridgePath = path.join(REPO_ROOT, 'systems', 'autonomy', 'backlog_autoscale_rust_bridge.js');

function loadInversion(rustEnabled) {
  process.env.INVERSION_RUST_ENABLED = rustEnabled ? '1' : '0';
  delete require.cache[inversionPath];
  delete require.cache[bridgePath];
  return require(inversionPath);
}

function run() {
  const ts = loadInversion(false);
  const rust = loadInversion(true);

  assert.strictEqual(rust.toDate('2026-03-04'), ts.toDate('2026-03-04'), 'toDate mismatch');

  assert.strictEqual(
    rust.parseTsMs('2026-03-04T00:00:00.000Z'),
    ts.parseTsMs('2026-03-04T00:00:00.000Z'),
    'parseTsMs mismatch'
  );

  assert.strictEqual(
    rust.addMinutes('2026-03-04T00:00:00.000Z', 15),
    ts.addMinutes('2026-03-04T00:00:00.000Z', 15),
    'addMinutes mismatch'
  );

  assert.strictEqual(rust.clampInt(12.8, 0, 10, 3), ts.clampInt(12.8, 0, 10, 3), 'clampInt mismatch');
  assert.strictEqual(rust.clampNumber(1.7, 0, 1, 0.5), ts.clampNumber(1.7, 0, 1, 0.5), 'clampNumber mismatch');

  const boolCases = [
    ['yes', false],
    ['off', true],
    ['unknown', true]
  ];
  for (const [value, fallback] of boolCases) {
    assert.strictEqual(rust.toBool(value, fallback), ts.toBool(value, fallback), `toBool mismatch for ${value}`);
  }

  assert.strictEqual(rust.cleanText('  a   b  ', 16), ts.cleanText('  a   b  ', 16), 'cleanText mismatch');
  assert.strictEqual(rust.normalizeToken('A B+C', 80), ts.normalizeToken('A B+C', 80), 'normalizeToken mismatch');
  assert.strictEqual(rust.normalizeWordToken('A B+C', 80), ts.normalizeWordToken('A B+C', 80), 'normalizeWordToken mismatch');
  assert.strictEqual(rust.bandToIndex('seasoned'), ts.bandToIndex('seasoned'), 'bandToIndex mismatch');

  console.log('inversion_helper_batch5_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`inversion_helper_batch5_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
