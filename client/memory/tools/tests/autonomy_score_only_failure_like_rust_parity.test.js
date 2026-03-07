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
  const cases = [
    { type: 'autonomy_run', result: 'stop_repeat_gate_preview_structural_cooldown' },
    { type: 'autonomy_run', result: 'stop_repeat_gate_preview_churn_cooldown' },
    { type: 'autonomy_run', result: 'score_only_preview', preview_verification: { passed: false, outcome: 'no_change' } },
    { type: 'autonomy_run', result: 'score_only_preview', preview_verification: { passed: true, outcome: 'no_change' } },
    { type: 'autonomy_run', result: 'score_only_preview', preview_verification: { passed: true, outcome: 'shipped' } },
    { type: 'autonomy_run', result: 'executed', preview_verification: { passed: false, outcome: 'no_change' } },
    { type: 'other_event', result: 'score_only_preview', preview_verification: { passed: false, outcome: 'no_change' } }
  ];

  for (const evt of cases) {
    const tsVal = loadController(false).isScoreOnlyFailureLikeEvent(evt);
    const rustVal = loadController(true).isScoreOnlyFailureLikeEvent(evt);
    assert.strictEqual(
      rustVal,
      tsVal,
      `isScoreOnlyFailureLikeEvent parity mismatch for ${evt.type}/${evt.result}`
    );
  }

  console.log('autonomy_score_only_failure_like_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_score_only_failure_like_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
