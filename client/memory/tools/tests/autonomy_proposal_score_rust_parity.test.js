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
  const today = new Date().toISOString().slice(0, 10);
  const cases = [
    {
      proposal: { expected_impact: 'high', risk: 'medium', title: 'A', summary: 'B' },
      overlay: { outcomes: { no_change: 0, reverted: 0 } },
      dateStr: today
    },
    {
      proposal: { expected_impact: 'low', risk: 'high', title: 'small', summary: 'task', evidence: [] },
      overlay: { outcomes: { no_change: 2, reverted: 1 } },
      dateStr: today
    }
  ];

  for (const tc of cases) {
    const tsOut = Number(loadController(false).proposalScore(tc.proposal, tc.overlay, tc.dateStr));
    const rustOut = Number(loadController(true).proposalScore(tc.proposal, tc.overlay, tc.dateStr));
    const delta = Math.abs(tsOut - rustOut);
    assert.ok(
      delta < 0.0001,
      `proposalScore parity mismatch for ${JSON.stringify(tc)}: ts=${tsOut} rust=${rustOut}`
    );
  }

  console.log('autonomy_proposal_score_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_proposal_score_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
