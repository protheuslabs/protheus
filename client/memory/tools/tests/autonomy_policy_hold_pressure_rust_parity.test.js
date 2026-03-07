#!/usr/bin/env node
'use strict';

const path = require('path');
const assert = require('assert');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const controllerPath = path.join(REPO_ROOT, 'systems', 'autonomy', 'autonomy_controller.js');
const bridgePath = path.join(REPO_ROOT, 'systems', 'autonomy', 'backlog_autoscale_rust_bridge.js');

function isoMinutesAgo(mins) {
  return new Date(Date.now() - (Math.max(0, Number(mins || 0)) * 60000)).toISOString();
}

function buildEvents() {
  return [
    { ts: isoMinutesAgo(12), type: 'autonomy_run', result: 'no_candidates_policy_daily_cap', policy_hold: true },
    { ts: isoMinutesAgo(10), type: 'autonomy_run', result: 'stop_init_gate_budget_autopause', policy_hold: true },
    { ts: isoMinutesAgo(8), type: 'autonomy_run', result: 'score_only_fallback_low_execution_confidence', policy_hold: true },
    { ts: isoMinutesAgo(6), type: 'autonomy_run', result: 'executed' },
    { ts: isoMinutesAgo(4), type: 'autonomy_run', result: 'init_gate_stub' },
    { ts: isoMinutesAgo(2), type: 'autonomy_run', result: 'stop_repeat_gate_candidate_exhausted' },
    { ts: isoMinutesAgo(1), type: 'autonomy_run', result: 'executed' },
    { ts: isoMinutesAgo(1500), type: 'autonomy_run', result: 'no_candidates_policy_daily_cap', policy_hold: true }
  ];
}

function loadController(rustEnabled) {
  process.env.AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED = rustEnabled ? '1' : '0';
  delete require.cache[controllerPath];
  delete require.cache[bridgePath];
  return require(controllerPath);
}

function run() {
  const events = buildEvents();
  const opts = { min_samples: 6, window_hours: 24 };

  const tsOnly = loadController(false).policyHoldPressureSnapshot(events, opts);
  const rustBacked = loadController(true).policyHoldPressureSnapshot(events, opts);

  assert.deepStrictEqual(
    rustBacked,
    tsOnly,
    'Rust-backed policy hold pressure snapshot must match TS fallback output'
  );
  assert.strictEqual(rustBacked.level, 'hard', 'snapshot should classify hard pressure for this fixture');
  assert.strictEqual(rustBacked.applicable, true, 'snapshot should be applicable over sample floor');

  console.log('autonomy_policy_hold_pressure_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_policy_hold_pressure_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
