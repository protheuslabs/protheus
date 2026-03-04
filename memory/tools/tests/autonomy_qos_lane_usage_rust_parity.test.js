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
  const runs = [
    { type: 'autonomy_run', result: 'executed', selection_mode: 'qos_critical_exploit' },
    { type: 'autonomy_run', result: 'executed', selection_mode: 'qos_standard_explore' },
    { type: 'autonomy_run', result: 'executed', selection_mode: 'qos_explore_explore' },
    { type: 'autonomy_run', result: 'executed', selection_mode: 'qos_quarantine_exploit' },
    { type: 'autonomy_run', result: 'stop_repeat_gate_no_progress', selection_mode: 'qos_critical_exploit' }
  ];

  const tsVal = loadController(false).qosLaneUsageFromRuns(runs);
  const rustVal = loadController(true).qosLaneUsageFromRuns(runs);
  assert.deepStrictEqual(rustVal, tsVal, 'qosLaneUsageFromRuns parity mismatch');

  console.log('autonomy_qos_lane_usage_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_qos_lane_usage_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
