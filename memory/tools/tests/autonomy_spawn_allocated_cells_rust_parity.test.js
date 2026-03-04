#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const controllerPath = path.join(REPO_ROOT, 'systems', 'autonomy', 'autonomy_controller.js');
const bridgePath = path.join(REPO_ROOT, 'systems', 'autonomy', 'backlog_autoscale_rust_bridge.js');

function loadController({ rustEnabled, spawnStateDir, autoscaleStatePath }) {
  process.env.AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED = rustEnabled ? '1' : '0';
  process.env.SPAWN_STATE_DIR = spawnStateDir;
  process.env.AUTONOMY_BACKLOG_AUTOSCALE_STATE_PATH = autoscaleStatePath;
  delete require.cache[controllerPath];
  delete require.cache[bridgePath];
  return require(controllerPath);
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload), 'utf8');
}

function run() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-spawn-cells-'));
  const allocationsPath = path.join(tmpDir, 'allocations.json');
  const autoscaleStatePath = path.join(tmpDir, 'backlog_autoscale_state.json');
  try {
    const tsController = loadController({
      rustEnabled: false,
      spawnStateDir: tmpDir,
      autoscaleStatePath
    });
    const rustController = loadController({
      rustEnabled: true,
      spawnStateDir: tmpDir,
      autoscaleStatePath
    });

    const scenarios = [
      { allocations: { active_cells: 2.9 }, state: {} },
      { allocations: { current_cells: 5 }, state: {} },
      { allocations: { allocated_cells: 1.2 }, state: {} },
      { allocations: {}, state: { current_cells: 3.4 } }
    ];

    for (const [idx, scenario] of scenarios.entries()) {
      writeJson(allocationsPath, scenario.allocations);
      writeJson(autoscaleStatePath, scenario.state);
      const tsOut = tsController.spawnAllocatedCells();
      const rustOut = rustController.spawnAllocatedCells();
      assert.strictEqual(
        rustOut,
        tsOut,
        `spawnAllocatedCells parity mismatch at scenario ${idx + 1}: ts=${tsOut} rust=${rustOut}`
      );
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log('autonomy_spawn_allocated_cells_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_spawn_allocated_cells_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
