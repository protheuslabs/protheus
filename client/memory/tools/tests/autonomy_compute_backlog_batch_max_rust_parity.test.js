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
      enabled: true,
      maxBatch: 4,
      dailyRemaining: 3,
      autoscaleSnapshot: {
        current_cells: 2,
        plan: { pressure: 'critical', budget_blocked: false, trit_shadow_blocked: false, current_cells: 2 }
      }
    },
    {
      enabled: true,
      maxBatch: 5,
      dailyRemaining: 10,
      autoscaleSnapshot: {
        current_cells: 1,
        plan: { pressure: 'warning', budget_blocked: false, trit_shadow_blocked: false, current_cells: 1 }
      }
    },
    {
      enabled: true,
      maxBatch: 5,
      dailyRemaining: 10,
      autoscaleSnapshot: {
        current_cells: 3,
        plan: { pressure: 'normal', budget_blocked: true, trit_shadow_blocked: false, current_cells: 3 }
      }
    },
    {
      enabled: false,
      maxBatch: 4,
      dailyRemaining: 4,
      autoscaleSnapshot: {
        current_cells: 1,
        plan: { pressure: 'normal', budget_blocked: false, trit_shadow_blocked: false, current_cells: 1 }
      }
    }
  ];

  for (const [idx, scenario] of scenarios.entries()) {
    const tsOut = tsController.computeBacklogBatchMax(scenario);
    const rustOut = rustController.computeBacklogBatchMax(scenario);
    assert.deepStrictEqual(
      rustOut,
      tsOut,
      `computeBacklogBatchMax parity mismatch scenario ${idx + 1}: ts=${JSON.stringify(tsOut)} rust=${JSON.stringify(rustOut)}`
    );
  }

  console.log('autonomy_compute_backlog_batch_max_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_compute_backlog_batch_max_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
