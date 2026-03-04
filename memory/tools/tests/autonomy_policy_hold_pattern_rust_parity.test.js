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
    {
      ts: isoMinutesAgo(15),
      type: 'autonomy_run',
      result: 'stop_init_gate_readiness',
      objective_id: 'T1_alpha',
      hold_reason: 'gate_manual',
      policy_hold: true
    },
    {
      ts: isoMinutesAgo(10),
      type: 'autonomy_run',
      result: 'stop_init_gate_readiness',
      objective_id: 'T1_alpha',
      hold_reason: 'gate_manual',
      policy_hold: true
    },
    {
      ts: isoMinutesAgo(6),
      type: 'autonomy_run',
      result: 'no_candidates_policy_daily_cap',
      objective_id: 'T1_beta',
      policy_hold: true
    },
    {
      ts: isoMinutesAgo(2),
      type: 'autonomy_run',
      result: 'executed',
      objective_id: 'T1_alpha'
    }
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
  const opts = { window_hours: 24, repeat_threshold: 2 };
  const objectiveId = 'T1_alpha';

  const tsOnly = loadController(false).objectivePolicyHoldPattern(events, objectiveId, opts);
  const rustBacked = loadController(true).objectivePolicyHoldPattern(events, objectiveId, opts);

  assert.deepStrictEqual(
    rustBacked,
    tsOnly,
    'Rust-backed policy hold pattern output must match TS fallback output'
  );
  assert.strictEqual(rustBacked.should_dampen, true, 'fixture should trigger dampener');
  assert.strictEqual(rustBacked.top_reason, 'gate_manual');

  console.log('autonomy_policy_hold_pattern_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_policy_hold_pattern_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
