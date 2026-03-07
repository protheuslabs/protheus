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
    {
      label: 'normal pressure keeps base cooldown',
      baseMinutes: 15,
      pressure: { applicable: false, level: 'normal' }
    },
    {
      label: 'warn pressure applies warn floor',
      baseMinutes: 5,
      pressure: { applicable: true, level: 'warn' }
    },
    {
      label: 'hard pressure applies hard floor',
      baseMinutes: 25,
      pressure: { applicable: true, level: 'hard' }
    },
    {
      label: 'unknown pressure does not upshift',
      baseMinutes: 40,
      pressure: { applicable: true, level: 'other' }
    },
    {
      label: 'null pressure handles safely',
      baseMinutes: null,
      pressure: null
    }
  ];

  for (const sample of cases) {
    const tsOut = loadController(false).policyHoldCooldownMinutesForPressure(sample.baseMinutes, sample.pressure);
    const rustOut = loadController(true).policyHoldCooldownMinutesForPressure(sample.baseMinutes, sample.pressure);
    assert.strictEqual(
      rustOut,
      tsOut,
      `policyHoldCooldownMinutesForPressure parity mismatch (${sample.label})`
    );
  }

  console.log('autonomy_policy_hold_cooldown_pressure_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_policy_hold_cooldown_pressure_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
