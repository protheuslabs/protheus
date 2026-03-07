#!/usr/bin/env node
'use strict';

const path = require('path');
const assert = require('assert');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const controllerPath = path.join(REPO_ROOT, 'systems', 'autonomy', 'autonomy_controller.js');
const bridgePath = path.join(REPO_ROOT, 'systems', 'autonomy', 'backlog_autoscale_rust_bridge.js');

function loadController(rustEnabled) {
  process.env.AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED = rustEnabled ? '1' : '0';
  delete require.cache[controllerPath];
  delete require.cache[bridgePath];
  return require(controllerPath);
}

function run() {
  const events = [
    { type: 'outcome', outcome: 'success', evidence_ref: 'eye:foo', ts: '2026-03-03T10:00:00.000Z' },
    { type: 'outcome', outcome: 'success', evidence_ref: 'eye:foo', ts: '2026-03-01T10:00:00.000Z' },
    { type: 'outcome', outcome: 'failure', evidence_ref: 'eye:foo', ts: '2026-03-03T10:00:00.000Z' },
    { type: 'outcome', outcome: 'success', evidence_ref: 'eye:bar', ts: '2026-03-03T10:00:00.000Z' }
  ];

  const tsVal = loadController(false).countEyeOutcomesInWindow(events, 'eye:foo', 'success', '2026-03-03', 2);
  const rustVal = loadController(true).countEyeOutcomesInWindow(events, 'eye:foo', 'success', '2026-03-03', 2);
  assert.strictEqual(rustVal, tsVal, 'countEyeOutcomesInWindow parity mismatch');

  console.log('autonomy_eye_outcome_count_window_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_eye_outcome_count_window_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
