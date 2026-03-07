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

  assert.strictEqual(rust.escapeRegex('a+b?c'), ts.escapeRegex('a+b?c'), 'escapeRegex mismatch');

  const tsPattern = ts.patternToWordRegex('risk guard');
  const rustPattern = rust.patternToWordRegex('risk guard');
  assert.strictEqual(Boolean(rustPattern), Boolean(tsPattern), 'patternToWordRegex nullability mismatch');
  assert.strictEqual(rustPattern && rustPattern.test('risk guard'), tsPattern && tsPattern.test('risk guard'), 'patternToWordRegex test mismatch');
  assert.strictEqual(rustPattern && rustPattern.test('risk only'), tsPattern && tsPattern.test('risk only'), 'patternToWordRegex negative mismatch');

  assert.strictEqual(rust.stableId('seed', 'inv'), ts.stableId('seed', 'inv'), 'stableId mismatch');

  const insidePath = path.join(REPO_ROOT, 'state', 'autonomy', 'inversion', 'latest.json');
  const outsidePath = path.join(path.dirname(REPO_ROOT), 'tmp-outside-test.json');

  assert.strictEqual(rust.relPath(insidePath), ts.relPath(insidePath), 'relPath mismatch (inside)');
  assert.strictEqual(rust.relPath(outsidePath), ts.relPath(outsidePath), 'relPath mismatch (outside)');

  assert.strictEqual(rust.normalizeAxiomPattern('  Risk   Guard  '), ts.normalizeAxiomPattern('  Risk   Guard  '), 'normalizeAxiomPattern mismatch');

  const signalTerms = [' Risk ', 'Guard', ''];
  assert.deepStrictEqual(
    rust.normalizeAxiomSignalTerms(signalTerms),
    ts.normalizeAxiomSignalTerms(signalTerms),
    'normalizeAxiomSignalTerms mismatch'
  );

  assert.strictEqual(rust.normalizeObserverId('Observer 01'), ts.normalizeObserverId('Observer 01'), 'normalizeObserverId mismatch');

  const numericCases = ['2.5', '', true, 'not-a-number', null];
  for (const value of numericCases) {
    assert.strictEqual(rust.extractNumeric(value), ts.extractNumeric(value), `extractNumeric mismatch for ${String(value)}`);
  }

  assert.strictEqual(
    rust.pickFirstNumeric(['not-a-number', '', 7]),
    ts.pickFirstNumeric(['not-a-number', '', 7]),
    'pickFirstNumeric mismatch'
  );

  assert.strictEqual(rust.safeRelPath(insidePath), ts.safeRelPath(insidePath), 'safeRelPath mismatch (inside)');
  assert.strictEqual(rust.safeRelPath(outsidePath), ts.safeRelPath(outsidePath), 'safeRelPath mismatch (outside)');

  console.log('inversion_helper_batch6_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`inversion_helper_batch6_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
