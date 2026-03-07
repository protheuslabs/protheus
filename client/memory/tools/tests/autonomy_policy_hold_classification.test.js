#!/usr/bin/env node
'use strict';

const path = require('path');
const assert = require('assert');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const controller = require(path.join(REPO_ROOT, 'systems', 'autonomy', 'autonomy_controller.js'));

function run() {
  assert.strictEqual(controller.isPolicyHoldResult('no_candidates_policy_daily_cap'), true);
  assert.strictEqual(controller.isPolicyHoldResult('stop_init_gate_budget_autopause'), true);
  assert.strictEqual(controller.isPolicyHoldResult('stop_init_gate_readiness'), true);
  assert.strictEqual(controller.isPolicyHoldResult('stop_init_gate_criteria_quality_insufficient'), true);
  assert.strictEqual(controller.isPolicyHoldResult('stop_init_gate_quality_exhausted'), false);

  assert.strictEqual(controller.isPolicyHoldRunEvent({
    type: 'autonomy_run',
    result: 'stop_init_gate_readiness'
  }), true);
  assert.strictEqual(controller.isPolicyHoldRunEvent({
    type: 'autonomy_run',
    result: 'stop_init_gate_quality_exhausted'
  }), false);

  const latest = controller.latestPolicyHoldRunEvent([
    { type: 'autonomy_run', result: 'stop_init_gate_quality_exhausted', ts: '2026-02-23T12:00:00.000Z' },
    { type: 'autonomy_run', result: 'stop_init_gate_readiness', ts: '2026-02-23T12:10:00.000Z' },
    { type: 'autonomy_run', result: 'stop_repeat_gate_interval', ts: '2026-02-23T12:11:00.000Z' },
    { type: 'autonomy_run', result: 'stop_init_gate_budget_autopause', ts: '2026-02-23T12:12:00.000Z' }
  ]);
  assert.ok(latest && latest.result === 'stop_init_gate_budget_autopause');

  console.log('autonomy_policy_hold_classification.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_policy_hold_classification.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
