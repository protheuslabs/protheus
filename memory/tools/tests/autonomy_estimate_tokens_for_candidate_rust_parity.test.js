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
    { cand: { est_tokens: 700 }, proposal: { meta: { route_tokens_est: 320 }, title: 'x', summary: 'y' } },
    { cand: { est_tokens: 0 }, proposal: { meta: { route_tokens_est: 320 }, title: 'x', summary: 'y' } },
    { cand: { est_tokens: 0 }, proposal: { meta: {}, title: 'hello world', summary: 'fallback estimate path' } },
    { cand: {}, proposal: {} }
  ];

  for (const tc of cases) {
    const tsOut = loadController(false).estimateTokensForCandidate(tc.cand, tc.proposal);
    const rustOut = loadController(true).estimateTokensForCandidate(tc.cand, tc.proposal);
    assert.strictEqual(
      rustOut,
      tsOut,
      `estimateTokensForCandidate parity mismatch for ${JSON.stringify(tc)}`
    );
  }

  console.log('autonomy_estimate_tokens_for_candidate_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_estimate_tokens_for_candidate_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
