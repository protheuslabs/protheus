#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-load-state-'));
  const statePath = path.join(tmpDir, 'state.json');
  fs.writeFileSync(statePath, JSON.stringify({
    module: 'autonomy_backlog_autoscale',
    current_cells: '3.9',
    target_cells: 9,
    last_run_ts: '2026-03-04T00:00:00.000Z',
    last_high_pressure_ts: '',
    last_action: 'scale_up',
    updated_at: null
  }), 'utf8');

  try {
    const tsController = loadController(false);
    const rustController = loadController(true);

    const tsOut = tsController.loadBacklogAutoscaleState(statePath);
    const rustOut = rustController.loadBacklogAutoscaleState(statePath);
    assert.deepStrictEqual(
      rustOut,
      tsOut,
      `loadBacklogAutoscaleState parity mismatch: ts=${JSON.stringify(tsOut)} rust=${JSON.stringify(rustOut)}`
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log('autonomy_load_backlog_autoscale_state_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_load_backlog_autoscale_state_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
