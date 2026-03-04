#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const controllerPath = path.join(REPO_ROOT, 'systems', 'autonomy', 'autonomy_controller.js');
const bridgePath = path.join(REPO_ROOT, 'systems', 'autonomy', 'backlog_autoscale_rust_bridge.js');

function loadController({ rustEnabled, spawnEventsPath }) {
  process.env.AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED = rustEnabled ? '1' : '0';
  process.env.AUTONOMY_DYNAMIC_IO_CAP_RESET_ON_SPAWN = '1';
  process.env.AUTONOMY_DYNAMIC_IO_CAP_SPAWN_LOOKBACK_MINUTES = '30';
  process.env.AUTONOMY_DYNAMIC_IO_CAP_SPAWN_MIN_GRANTED_CELLS = '1';
  process.env.SPAWN_EVENTS_PATH = spawnEventsPath;
  delete require.cache[controllerPath];
  delete require.cache[bridgePath];
  return require(controllerPath);
}

function run() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-spawn-boost-'));
  const eventsPath = path.join(tmpDir, 'events.jsonl');
  const nowMs = Date.parse('2026-03-04T01:00:00.000Z');
  const rows = [
    { type: 'spawn_request', ts: '2026-03-04T00:58:00.000Z', granted_cells: 2 },
    { type: 'spawn_request', ts: '2026-03-04T00:50:00.000Z', granted_cells: 1 },
    { type: 'spawn_release', ts: '2026-03-04T00:57:00.000Z', granted_cells: 5 },
    { type: 'spawn_request', ts: '2026-03-03T20:00:00.000Z', granted_cells: 4 }
  ];
  fs.writeFileSync(eventsPath, rows.map((row) => `${JSON.stringify(row)}\n`).join(''), 'utf8');

  try {
    const tsController = loadController({ rustEnabled: false, spawnEventsPath: eventsPath });
    const rustController = loadController({ rustEnabled: true, spawnEventsPath: eventsPath });
    const tsOut = tsController.spawnCapacityBoostSnapshot(nowMs);
    const rustOut = rustController.spawnCapacityBoostSnapshot(nowMs);
    assert.deepStrictEqual(
      rustOut,
      tsOut,
      `spawnCapacityBoostSnapshot parity mismatch: ts=${JSON.stringify(tsOut)} rust=${JSON.stringify(rustOut)}`
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log('autonomy_spawn_capacity_boost_snapshot_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_spawn_capacity_boost_snapshot_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
