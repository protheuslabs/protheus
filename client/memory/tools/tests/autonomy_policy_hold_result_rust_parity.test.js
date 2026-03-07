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
  const holdResults = [
    'no_candidates_policy_daily_cap',
    'stop_init_gate_budget_autopause',
    'stop_init_gate_readiness',
    'stop_init_gate_readiness_blocked',
    'stop_init_gate_criteria_quality_insufficient',
    'stop_repeat_gate_mutation_guard',
    'score_only_fallback_route_block',
    'score_only_fallback_low_execution_confidence'
  ];
  const nonHoldResults = [
    'executed',
    'stop_init_gate_quality_exhausted',
    'stop_repeat_gate_interval',
    'random_result'
  ];

  for (const result of holdResults.concat(nonHoldResults)) {
    const tsVal = loadController(false).isPolicyHoldResult(result);
    const rustVal = loadController(true).isPolicyHoldResult(result);
    assert.strictEqual(rustVal, tsVal, `isPolicyHoldResult parity mismatch for ${result}`);
  }

  console.log('autonomy_policy_hold_result_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_policy_hold_result_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
