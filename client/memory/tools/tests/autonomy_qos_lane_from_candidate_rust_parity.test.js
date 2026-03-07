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
  const cases = [
    {
      queue_underflow_backfill: true,
      proposal: { type: 'other', risk: 'low' },
      directive_pulse: { tier: 5 }
    },
    {
      queue_underflow_backfill: false,
      proposal: { type: 'other', risk: 'low' },
      directive_pulse: { tier: 1 }
    },
    {
      queue_underflow_backfill: false,
      proposal: { type: 'directive_clarification', risk: 'low' },
      directive_pulse: { tier: 4 }
    },
    {
      queue_underflow_backfill: false,
      proposal: { type: 'other', risk: 'medium' },
      directive_pulse: { tier: 4 }
    },
    {
      queue_underflow_backfill: false,
      proposal: { type: 'other', risk: 'low' },
      directive_pulse: { tier: 4 }
    }
  ];

  for (const cand of cases) {
    const tsOut = loadController(false).qosLaneFromCandidate(cand);
    const rustOut = loadController(true).qosLaneFromCandidate(cand);
    assert.strictEqual(
      rustOut,
      tsOut,
      `qosLaneFromCandidate parity mismatch for ${JSON.stringify(cand)}`
    );
  }

  console.log('autonomy_qos_lane_from_candidate_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_qos_lane_from_candidate_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
