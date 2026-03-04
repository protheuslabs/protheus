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
    module: String(row.module || ''),
    current_cells: Number(row.current_cells || 0),
    queue_pressure: String((((row.queue || {}).pressure) || '').toLowerCase()),
    plan_action: String((((row.plan || {}).action) || '')),
    trit_hold: ((row.trit_productivity || {}).hold) === true
  };
}

function run() {
  const ts = loadAutonomy(false);
  const rust = loadAutonomy(true);

  const opts = {
    queuePressure: {
      pressure: 'warning',
      pending: 4,
      pending_ratio: 0.45
    },
    budgetAutopause: { active: false },
    tritProductivity: { hold: false }
  };

  const tsOut = normalize(ts.backlogAutoscaleSnapshot('2026-03-04', opts));
  const rustOut = normalize(rust.backlogAutoscaleSnapshot('2026-03-04', opts));
  assert.deepStrictEqual(rustOut, tsOut, 'backlogAutoscaleSnapshot mismatch');

  console.log('autonomy_backlog_snapshot_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_backlog_snapshot_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
