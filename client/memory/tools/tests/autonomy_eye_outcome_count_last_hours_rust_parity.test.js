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
  const now = Date.parse('2026-03-03T12:00:00.000Z');
  const events = [
    { type: 'outcome', outcome: 'success', evidence_ref: 'eye:foo', ts: '2026-03-03T11:00:00.000Z' },
    { type: 'outcome', outcome: 'success', evidence_ref: 'eye:foo', ts: '2026-03-02T06:00:00.000Z' },
    { type: 'outcome', outcome: 'failure', evidence_ref: 'eye:foo', ts: '2026-03-03T11:00:00.000Z' }
  ];

  const originalNow = Date.now;
  Date.now = () => now;
  try {
    const tsVal = loadController(false).countEyeOutcomesInLastHours(events, 'eye:foo', 'success', 6);
    const rustVal = loadController(true).countEyeOutcomesInLastHours(events, 'eye:foo', 'success', 6);
    assert.strictEqual(rustVal, tsVal, 'countEyeOutcomesInLastHours parity mismatch');
  } finally {
    Date.now = originalNow;
  }

  console.log('autonomy_eye_outcome_count_last_hours_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_eye_outcome_count_last_hours_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
