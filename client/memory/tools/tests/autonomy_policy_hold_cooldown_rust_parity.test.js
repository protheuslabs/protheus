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
  const pressure = {
    level: 'hard',
    applicable: true,
    samples: 8,
    policy_holds: 5,
    rate: 0.625
  };
  const lastRun = {
    result: 'stop_init_gate_readiness'
  };

  const tsOnly = loadController(false).policyHoldCooldownMinutesForResult(15, pressure, lastRun);
  const rustBacked = loadController(true).policyHoldCooldownMinutesForResult(15, pressure, lastRun);

  assert.strictEqual(
    rustBacked,
    tsOnly,
    'Rust-backed policy-hold cooldown must match TS fallback output'
  );
  assert.ok(rustBacked >= 60, 'fixture should produce escalated cooldown under hard pressure');

  console.log('autonomy_policy_hold_cooldown_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_policy_hold_cooldown_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
