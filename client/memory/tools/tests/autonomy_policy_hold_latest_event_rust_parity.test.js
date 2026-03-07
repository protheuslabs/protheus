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
    {
      type: 'autonomy_run',
      result: 'executed',
      outcome: 'no_change',
      ts: '2026-03-01T00:00:00.000Z'
    },
    {
      type: 'autonomy_run',
      result: 'stop_init_gate_readiness',
      hold_reason: 'gate_manual',
      ts: '2026-03-01T00:01:00.000Z'
    },
    {
      type: 'autonomy_run',
      result: 'executed',
      outcome: 'shipped',
      ts: '2026-03-01T00:02:00.000Z'
    }
  ];

  const tsOut = loadController(false).latestPolicyHoldRunEvent(events);
  const rustOut = loadController(true).latestPolicyHoldRunEvent(events);
  assert.deepStrictEqual(rustOut, tsOut, 'latestPolicyHoldRunEvent rust path must match TS fallback');

  const explicitPolicyHold = [
    {
      type: 'autonomy_run',
      result: '',
      policy_hold: true,
      route_block_reason: 'budget_guard_blocked',
      ts: '2026-03-01T00:03:00.000Z'
    }
  ];
  const tsExplicit = loadController(false).latestPolicyHoldRunEvent(explicitPolicyHold);
  const rustExplicit = loadController(true).latestPolicyHoldRunEvent(explicitPolicyHold);
  assert.deepStrictEqual(rustExplicit, tsExplicit, 'explicit policy_hold event must roundtrip identically');

  console.log('autonomy_policy_hold_latest_event_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_policy_hold_latest_event_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
