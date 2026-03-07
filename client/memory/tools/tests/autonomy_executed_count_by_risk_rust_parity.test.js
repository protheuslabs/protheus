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
    { type: 'autonomy_run', result: 'executed', risk: 'high' },
    { type: 'autonomy_run', result: 'executed', risk: 'medium' },
    { type: 'autonomy_run', result: 'executed', proposal_risk: 'medium' },
    { type: 'autonomy_run', result: 'stop_repeat_gate_no_progress', risk: 'high' },
    { type: 'outcome', result: 'executed', risk: 'high' }
  ];
  const risks = ['high', 'medium', 'low', 'unknown'];

  for (const risk of risks) {
    const tsVal = loadController(false).executedCountByRisk(events, risk);
    const rustVal = loadController(true).executedCountByRisk(events, risk);
    assert.strictEqual(
      rustVal,
      tsVal,
      `executedCountByRisk parity mismatch for risk=${risk}`
    );
  }

  console.log('autonomy_executed_count_by_risk_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_executed_count_by_risk_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
