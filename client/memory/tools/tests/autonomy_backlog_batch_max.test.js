#!/usr/bin/env node
'use strict';

const assert = require('assert');
const ctrl = require('../../../systems/autonomy/autonomy_controller.js');

function main() {
  const disabled = ctrl.computeBacklogBatchMax({
    enabled: false,
    maxBatch: 4,
    autoscaleSnapshot: {
      current_cells: 2,
      plan: { pressure: 'critical', target_cells: 2, action: 'scale_up' }
    },
    dailyRemaining: 4
  });
  assert.strictEqual(disabled.max, 1, 'disabled mode should not batch');
  assert.strictEqual(disabled.reason, 'disabled');

  const blocked = ctrl.computeBacklogBatchMax({
    enabled: true,
    maxBatch: 4,
    autoscaleSnapshot: {
      current_cells: 2,
      plan: { pressure: 'critical', target_cells: 2, action: 'scale_up', budget_blocked: true }
    },
    dailyRemaining: 4
  });
  assert.strictEqual(blocked.max, 1, 'budget blocked should not batch');
  assert.strictEqual(blocked.reason, 'budget_blocked');

  const critical = ctrl.computeBacklogBatchMax({
    enabled: true,
    maxBatch: 4,
    autoscaleSnapshot: {
      current_cells: 2,
      plan: { pressure: 'critical', target_cells: 2, action: 'scale_up' }
    },
    dailyRemaining: 6
  });
  assert.strictEqual(critical.max, 3, 'critical pressure with 2 cells should suggest 3-run batch');
  assert.strictEqual(critical.reason, 'backlog_autoscale');

  const warning = ctrl.computeBacklogBatchMax({
    enabled: true,
    maxBatch: 5,
    autoscaleSnapshot: {
      current_cells: 4,
      plan: { pressure: 'warning', target_cells: 4, action: 'scale_up' }
    },
    dailyRemaining: 9
  });
  assert.strictEqual(warning.max, 2, 'warning pressure should cap batch width at 2');
  assert.strictEqual(warning.reason, 'backlog_autoscale');

  const capped = ctrl.computeBacklogBatchMax({
    enabled: true,
    maxBatch: 5,
    autoscaleSnapshot: {
      current_cells: 3,
      plan: { pressure: 'critical', target_cells: 3, action: 'scale_up' }
    },
    dailyRemaining: 1
  });
  assert.strictEqual(capped.max, 1, 'daily remaining cap should clamp batch max');
  assert.strictEqual(capped.reason, 'daily_cap_limited');

  const normal = ctrl.computeBacklogBatchMax({
    enabled: true,
    maxBatch: 4,
    autoscaleSnapshot: {
      current_cells: 0,
      plan: { pressure: 'normal', target_cells: 0, action: 'hold' }
    },
    dailyRemaining: 4
  });
  assert.strictEqual(normal.max, 1, 'normal pressure should not batch');
  assert.strictEqual(normal.reason, 'no_pressure');

  console.log('autonomy_backlog_batch_max.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`autonomy_backlog_batch_max.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

