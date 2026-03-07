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

function hoursAgoIso(hours) {
  return new Date(Date.now() - (hours * 60 * 60 * 1000)).toISOString();
}

function run() {
  const tsController = loadController(false);
  const rustController = loadController(true);

  const scenarios = [
    {
      queuePressure: { pressure: 'critical', pending: 12, total: 15, pending_ratio: 0.8 },
      minCells: 0,
      maxCells: 3,
      currentCells: 1,
      runIntervalMinutes: 5,
      idleReleaseMinutes: 30,
      autopauseActive: false,
      lastRunTs: null,
      lastHighPressureTs: null
    },
    {
      queuePressure: { pressure: 'warning', pending: 6, total: 12, pending_ratio: 0.5 },
      minCells: 0,
      maxCells: 4,
      currentCells: 2,
      runIntervalMinutes: 5,
      idleReleaseMinutes: 30,
      autopauseActive: false,
      lastRunTs: null,
      lastHighPressureTs: null
    },
    {
      queuePressure: { pressure: 'normal', pending: 0, total: 20, pending_ratio: 0 },
      minCells: 0,
      maxCells: 4,
      currentCells: 3,
      runIntervalMinutes: 5,
      idleReleaseMinutes: 30,
      autopauseActive: false,
      lastRunTs: null,
      lastHighPressureTs: hoursAgoIso(3)
    },
    {
      queuePressure: { pressure: 'critical', pending: 14, total: 20, pending_ratio: 0.7 },
      minCells: 0,
      maxCells: 5,
      currentCells: 1,
      runIntervalMinutes: 5,
      idleReleaseMinutes: 30,
      autopauseActive: false,
      lastRunTs: null,
      lastHighPressureTs: null,
      tritProductivity: { enabled: true, active: false }
    }
  ];

  for (const [idx, scenario] of scenarios.entries()) {
    const tsOut = tsController.computeBacklogAutoscalePlan(scenario);
    const rustOut = rustController.computeBacklogAutoscalePlan(scenario);
    assert.deepStrictEqual(
      rustOut,
      tsOut,
      `computeBacklogAutoscalePlan parity mismatch scenario ${idx + 1}: ts=${JSON.stringify(tsOut)} rust=${JSON.stringify(rustOut)}`
    );
  }

  console.log('autonomy_compute_backlog_autoscale_plan_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_compute_backlog_autoscale_plan_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
