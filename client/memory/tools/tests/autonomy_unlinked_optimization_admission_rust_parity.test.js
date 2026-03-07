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
    applies: row.applies === true,
    linked: row.linked === true,
    penalty: Number(row.penalty || 0),
    block: row.block === true,
    reason: row.reason == null ? null : String(row.reason)
  };
}

function run() {
  const ts = loadAutonomy(false);
  const rust = loadAutonomy(true);

  const proposal = {
    type: 'optimization',
    risk: 'high',
    title: 'Optimize pipeline throughput by 22%'
  };

  const binding = {
    pass: false,
    objective_id: null,
    valid: false
  };

  const tsOut = normalize(ts.assessUnlinkedOptimizationAdmission(proposal, binding, 'high'));
  const rustOut = normalize(rust.assessUnlinkedOptimizationAdmission(proposal, binding, 'high'));
  assert.deepStrictEqual(rustOut, tsOut, 'assessUnlinkedOptimizationAdmission mismatch');

  console.log('autonomy_unlinked_optimization_admission_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_unlinked_optimization_admission_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
