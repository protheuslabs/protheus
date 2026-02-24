#!/usr/bin/env node
'use strict';

const path = require('path');
const assert = require('assert');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const controller = require(path.join(REPO_ROOT, 'systems', 'autonomy', 'autonomy_controller.js'));

function isoMinutesAgo(mins) {
  return new Date(Date.now() - (Math.max(0, Number(mins || 0)) * 60000)).toISOString();
}

function run() {
  const critical = controller.computeBacklogAutoscalePlan({
    queuePressure: { pressure: 'critical', total: 120, pending: 88, pending_ratio: 0.733333 },
    currentCells: 0,
    minCells: 0,
    maxCells: 3,
    lastRunTs: isoMinutesAgo(30),
    lastHighPressureTs: isoMinutesAgo(60),
    autopauseActive: false,
    runIntervalMinutes: 10,
    idleReleaseMinutes: 120
  });
  assert.strictEqual(critical.action, 'scale_up', 'critical backlog should scale up');
  assert.strictEqual(critical.target_cells, 3, 'critical backlog should target max cells');
  assert.strictEqual(critical.reason, 'backlog_critical', 'critical backlog reason should be explicit');

  const cooldownHold = controller.computeBacklogAutoscalePlan({
    queuePressure: { pressure: 'critical', total: 120, pending: 88, pending_ratio: 0.733333 },
    currentCells: 0,
    minCells: 0,
    maxCells: 3,
    lastRunTs: isoMinutesAgo(2),
    lastHighPressureTs: isoMinutesAgo(60),
    autopauseActive: false,
    runIntervalMinutes: 10,
    idleReleaseMinutes: 120
  });
  assert.strictEqual(cooldownHold.action, 'cooldown_hold', 'scale-up requests should hold inside cooldown window');

  const autopauseBlocked = controller.computeBacklogAutoscalePlan({
    queuePressure: { pressure: 'critical', total: 120, pending: 88, pending_ratio: 0.733333 },
    currentCells: 1,
    minCells: 0,
    maxCells: 3,
    lastRunTs: isoMinutesAgo(30),
    lastHighPressureTs: isoMinutesAgo(60),
    autopauseActive: true,
    runIntervalMinutes: 10,
    idleReleaseMinutes: 120
  });
  assert.strictEqual(autopauseBlocked.action, 'hold', 'autopause should block scale-up actions');
  assert.strictEqual(autopauseBlocked.target_cells, 1, 'autopause should clamp target to current cells');
  assert.strictEqual(autopauseBlocked.reason, 'budget_autopause_active', 'autopause block reason should be explicit');

  const idleScaleDown = controller.computeBacklogAutoscalePlan({
    queuePressure: { pressure: 'normal', total: 120, pending: 5, pending_ratio: 0.041667 },
    currentCells: 2,
    minCells: 0,
    maxCells: 3,
    lastRunTs: isoMinutesAgo(30),
    lastHighPressureTs: isoMinutesAgo(240),
    autopauseActive: false,
    runIntervalMinutes: 10,
    idleReleaseMinutes: 120
  });
  assert.strictEqual(idleScaleDown.action, 'scale_down', 'idle backlog should scale down');
  assert.strictEqual(idleScaleDown.target_cells, 0, 'idle backlog should release down to floor');
  assert.strictEqual(idleScaleDown.idle_release_ready, true, 'idle release signal should be true when eligible');

  const idleHold = controller.computeBacklogAutoscalePlan({
    queuePressure: { pressure: 'normal', total: 120, pending: 5, pending_ratio: 0.041667 },
    currentCells: 2,
    minCells: 0,
    maxCells: 3,
    lastRunTs: isoMinutesAgo(30),
    lastHighPressureTs: isoMinutesAgo(30),
    autopauseActive: false,
    runIntervalMinutes: 10,
    idleReleaseMinutes: 120
  });
  assert.strictEqual(idleHold.action, 'hold', 'recent pressure should hold cells instead of immediate release');
  assert.strictEqual(idleHold.reason, 'idle_hold', 'recent pressure hold reason should be explicit');

  console.log('autonomy_backlog_autoscale.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_backlog_autoscale.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
