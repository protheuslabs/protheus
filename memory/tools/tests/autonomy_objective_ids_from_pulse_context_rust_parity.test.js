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

function normalizeSet(s) {
  return Array.from(s || []).map((x) => String(x || '')).filter(Boolean);
}

function run() {
  const pulseCtx = {
    objectives: [
      { id: 'OBJ-1', tier: 1 },
      { id: 'OBJ-2', tier: 2 },
      { id: 'OBJ-1', tier: 1 }
    ]
  };

  const ts = loadAutonomy(false);
  const rust = loadAutonomy(true);

  const tsOut = normalizeSet(ts.objectiveIdsFromPulseContext(pulseCtx));
  const rustOut = normalizeSet(rust.objectiveIdsFromPulseContext(pulseCtx));
  assert.deepStrictEqual(rustOut, tsOut, 'objectiveIdsFromPulseContext mismatch');

  console.log('autonomy_objective_ids_from_pulse_context_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_objective_ids_from_pulse_context_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
