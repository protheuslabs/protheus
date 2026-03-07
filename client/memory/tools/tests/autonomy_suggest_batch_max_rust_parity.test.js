#!/usr/bin/env node
'use strict';

const path = require('path');
const assert = require('assert');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const autonomyPath = path.join(REPO_ROOT, 'systems', 'autonomy', 'autonomy_controller.js');
const bridgePath = path.join(REPO_ROOT, 'systems', 'autonomy', 'backlog_autoscale_rust_bridge.js');

function loadAutonomy(rustEnabled) {
  process.env.AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED = rustEnabled ? '1' : '0';
  delete require.cache[autonomyPath];
  delete require.cache[bridgePath];
  return require(autonomyPath);
}

function normalize(out) {
  const row = out && typeof out === 'object' ? out : {};
  return {
    enabled: row.enabled === true,
    max: Number(row.max || 1),
    reason: String(row.reason || ''),
    daily_remaining: Number(row.daily_remaining || 0)
  };
}

function run() {
  const ts = loadAutonomy(false);
  const rust = loadAutonomy(true);

  const opts = {
    strategyBudget: { daily_runs_cap: 12 },
    queuePressure: { pressure: 'warning', pending: 5, pending_ratio: 0.4 },
    budgetAutopause: { active: false },
    tritProductivity: { hold: false },
    autoscaleSnapshot: {
      plan: {
        pressure: 'warning',
        current_cells: 1,
        budget_blocked: false,
        trit_shadow_blocked: false
      },
      current_cells: 1
    }
  };

  const tsOut = normalize(ts.suggestAutonomyRunBatchMax('2026-03-04', opts));
  const rustOut = normalize(rust.suggestAutonomyRunBatchMax('2026-03-04', opts));
  assert.deepStrictEqual(rustOut, tsOut, 'suggestAutonomyRunBatchMax mismatch');

  console.log('autonomy_suggest_batch_max_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_suggest_batch_max_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
