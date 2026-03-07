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
    'score_only_preview',
    'score_only_evidence',
    'stop_repeat_gate_preview_structural_cooldown',
    'stop_repeat_gate_preview_churn_cooldown',
    'executed',
    'stop_repeat_gate_candidate_exhausted',
    ''
  ];

  for (const result of cases) {
    const tsVal = loadController(false).isScoreOnlyResult(result);
    const rustVal = loadController(true).isScoreOnlyResult(result);
    assert.strictEqual(
      rustVal,
      tsVal,
      `isScoreOnlyResult parity mismatch for ${result}`
    );
  }

  console.log('autonomy_score_only_result_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_score_only_result_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
