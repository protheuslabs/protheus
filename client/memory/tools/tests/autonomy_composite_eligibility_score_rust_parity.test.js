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
    { q: 80, d: 50, a: 90 },
    { q: 0, d: 0, a: 0 },
    { q: 120, d: -10, a: 55 },
    { q: '75', d: '33', a: '66' },
    { q: null, d: undefined, a: 'abc' }
  ];

  for (const tc of cases) {
    const tsOut = loadController(false).compositeEligibilityScore(tc.q, tc.d, tc.a);
    const rustOut = loadController(true).compositeEligibilityScore(tc.q, tc.d, tc.a);
    assert.strictEqual(
      rustOut,
      tsOut,
      `compositeEligibilityScore parity mismatch for ${JSON.stringify(tc)}`
    );
  }

  console.log('autonomy_composite_eligibility_score_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_composite_eligibility_score_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
