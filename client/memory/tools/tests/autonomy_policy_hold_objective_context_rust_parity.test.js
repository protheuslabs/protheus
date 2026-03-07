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

function normalize(raw) {
  const row = raw && typeof raw === 'object' ? raw : {};
  return {
    objective_id: row.objective_id ? String(row.objective_id) : null,
    objective_source: row.objective_source ? String(row.objective_source) : null,
    objective_ids: Array.isArray(row.objective_ids) ? row.objective_ids.map((x) => String(x || '')) : null
  };
}

function run() {
  const ts = loadAutonomy(false);
  const rust = loadAutonomy(true);

  const pulseCtx = {
    dominant_objective_id: 'OBJ_MAIN',
    objectives: [{ id: 'OBJ_A' }, { id: 'OBJ_B' }]
  };
  const candidateObjectiveIds = ['obj_candidate', 'OBJ_CANDIDATE'];

  const tsOut = normalize(ts.policyHoldObjectiveContext(pulseCtx, candidateObjectiveIds));
  const rustOut = normalize(rust.policyHoldObjectiveContext(pulseCtx, candidateObjectiveIds));
  assert.deepStrictEqual(rustOut, tsOut, 'policyHoldObjectiveContext mismatch');

  console.log('autonomy_policy_hold_objective_context_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_policy_hold_objective_context_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
