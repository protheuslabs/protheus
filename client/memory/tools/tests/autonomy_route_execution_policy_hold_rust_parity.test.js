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
  const summary = {
    gate_decision: 'ALLOW',
    decision: 'MANUAL',
    needs_manual_review: false,
    executable: false,
    route_reason: 'manual_approval_required'
  };

  const tsOut = loadController(false).routeExecutionPolicyHold(summary, 'route');
  const rustOut = loadController(true).routeExecutionPolicyHold(summary, 'route');
  assert.deepStrictEqual(rustOut, tsOut, 'routeExecutionPolicyHold rust path must match TS fallback');

  const budgetSummary = {
    gate_decision: 'ALLOW',
    route_decision_raw: 'ALLOW',
    needs_manual_review: false,
    executable: true,
    budget_enforcement: { blocked: true, reason: 'budget guard blocked' }
  };
  const tsBudget = loadController(false).routeExecutionPolicyHold(budgetSummary, 'route');
  const rustBudget = loadController(true).routeExecutionPolicyHold(budgetSummary, 'route');
  assert.deepStrictEqual(rustBudget, tsBudget, 'budget-blocked route policy hold must match TS fallback');

  console.log('autonomy_route_execution_policy_hold_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_route_execution_policy_hold_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
