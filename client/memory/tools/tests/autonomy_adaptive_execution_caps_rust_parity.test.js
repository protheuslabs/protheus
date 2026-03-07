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
  const tsController = loadController(false);
  const rustController = loadController(true);

  const scenarios = [
    {
      baseDailyCap: 8,
      baseCanaryCap: 3,
      candidatePoolSize: 16,
      queuePressure: { pressure: 'critical', pending: 12, total: 14, pending_ratio: 0.85 },
      policyHoldPressure: { level: 'normal', applicable: false },
      shippedToday: 0,
      noProgressStreak: 1,
      gateExhaustionStreak: 0,
      spawnCapacityBoost: { enabled: false, active: false }
    },
    {
      baseDailyCap: 10,
      baseCanaryCap: 2,
      candidatePoolSize: 20,
      queuePressure: { pressure: 'normal', pending: 1, total: 12, pending_ratio: 0.08 },
      policyHoldPressure: { level: 'warn', applicable: true },
      shippedToday: 0,
      noProgressStreak: 0,
      gateExhaustionStreak: 0,
      spawnCapacityBoost: { enabled: false, active: false }
    },
    {
      baseDailyCap: 12,
      baseCanaryCap: 2,
      candidatePoolSize: 30,
      queuePressure: { pressure: 'warning', pending: 5, total: 12, pending_ratio: 0.42 },
      policyHoldPressure: { level: 'normal', applicable: false },
      shippedToday: 2,
      noProgressStreak: 0,
      gateExhaustionStreak: 0,
      spawnCapacityBoost: { enabled: true, active: true }
    }
  ];

  for (const [idx, scenario] of scenarios.entries()) {
    const tsOut = tsController.adaptiveExecutionCaps(scenario);
    const rustOut = rustController.adaptiveExecutionCaps(scenario);
    assert.deepStrictEqual(
      rustOut,
      tsOut,
      `adaptiveExecutionCaps parity mismatch scenario ${idx + 1}: ts=${JSON.stringify(tsOut)} rust=${JSON.stringify(rustOut)}`
    );
  }

  console.log('autonomy_adaptive_execution_caps_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_adaptive_execution_caps_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
