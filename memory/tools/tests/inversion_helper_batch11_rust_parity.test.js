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

  const base = {
    objective: 'Harden inversion lane',
    objective_id: 'BL-214',
    ts: '2026-03-04T00:00:00.000Z',
    mode: 'test',
    impact: 'high',
    target: 'directive',
    certainty: 0.7333333,
    maturity_band: 'developing',
    reasons: ['one', 'two'],
    shadow_mode: true
  };
  const args = {
    code_change_title: 'Migrate proposal draft builder',
    code_change_summary: 'Rust-first proposal generation with parity fallback.',
    code_change_files: ['systems/autonomy/inversion_controller.ts'],
    code_change_tests: ['memory/tools/tests/inversion_helper_batch11_rust_parity.test.js'],
    code_change_risk: 'low'
  };
  const opts = {
    session_id: 'ivs_123',
    sandbox_verified: true
  };

  assert.deepStrictEqual(
    rust.buildCodeChangeProposalDraft(base, args, opts),
    ts.buildCodeChangeProposalDraft(base, args, opts),
    'buildCodeChangeProposalDraft mismatch'
  );

  console.log('inversion_helper_batch11_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`inversion_helper_batch11_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
