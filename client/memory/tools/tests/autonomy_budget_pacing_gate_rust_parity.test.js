#!/usr/bin/env node
'use strict';

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
  const rows = [
    {
      cand: { est_tokens: 1800, proposal: { type: 'ops_remediation' } },
      valueSignal: { score: 45 },
      risk: 'medium',
      snapshot: {
        tight: true,
        autopause_active: false,
        remaining_ratio: 0.15,
        pressure: 'hard',
        execution_reserve_remaining: 200
      },
      opts: { execution_floor_deficit: false }
    },
    {
      cand: { est_tokens: 300, proposal: { type: 'feature' } },
      valueSignal: { score: 82 },
      risk: 'low',
      snapshot: {
        tight: true,
        autopause_active: false,
        remaining_ratio: 0.1,
        pressure: 'warn',
        execution_reserve_remaining: 800
      },
      opts: { execution_floor_deficit: true }
    },
    {
      cand: { est_tokens: 500, proposal: { type: 'feature' } },
      valueSignal: { score: 90 },
      risk: 'medium',
      snapshot: {
        tight: true,
        autopause_active: true,
        remaining_ratio: 0.2,
        pressure: 'hard',
        execution_reserve_remaining: 100
      },
      opts: { execution_floor_deficit: false }
    }
  ];

  const tsController = loadController(false);
  const rustController = loadController(true);

  for (const row of rows) {
    const tsOut = tsController.evaluateBudgetPacingGate(row.cand, row.valueSignal, row.risk, row.snapshot, row.opts);
    const rustOut = rustController.evaluateBudgetPacingGate(row.cand, row.valueSignal, row.risk, row.snapshot, row.opts);
    assert.deepStrictEqual(
      rustOut,
      tsOut,
      `evaluateBudgetPacingGate parity mismatch for ${JSON.stringify(row)}`
    );
  }

  console.log('autonomy_budget_pacing_gate_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_budget_pacing_gate_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
