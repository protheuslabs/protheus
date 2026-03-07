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

  const row = {
    id: ' abc ',
    ts: '2026-03-04T00:00:00.000Z',
    objective: ' Ship lane ',
    objective_id: ' BL-215 ',
    signature: '  reduce drift safely ',
    target: 'directive',
    impact: 'high',
    certainty: 1.2,
    filter_stack: ['risk_guard', '  '],
    outcome_trit: 2,
    result: 'OK',
    maturity_band: 'Developing',
    principle_id: ' p1 ',
    session_id: ' s1 '
  };

  assert.deepStrictEqual(
    rust.normalizeLibraryRow(row),
    ts.normalizeLibraryRow(row),
    'normalizeLibraryRow mismatch'
  );

  console.log('inversion_helper_batch12_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`inversion_helper_batch12_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
