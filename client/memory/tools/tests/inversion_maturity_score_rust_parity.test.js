#!/usr/bin/env node
'use strict';

const path = require('path');
const assert = require('assert');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const inversionPath = path.join(REPO_ROOT, 'systems', 'autonomy', 'inversion_controller.js');
const bridgePath = path.join(REPO_ROOT, 'systems', 'autonomy', 'backlog_autoscale_rust_bridge.js');

function loadInversion(rustEnabled) {
  process.env.INVERSION_RUST_ENABLED = rustEnabled ? '1' : '0';
  delete require.cache[inversionPath];
  delete require.cache[bridgePath];
  return require(inversionPath);
}

function run() {
  const policy = {
    maturity: {
      target_test_count: 40,
      score_weights: {
        pass_rate: 0.5,
        non_destructive_rate: 0.3,
        experience: 0.2
      },
      bands: {
        novice: 0.25,
        developing: 0.45,
        mature: 0.65,
        seasoned: 0.82
      }
    }
  };
  const states = [
    {
      stats: {
        total_tests: 0,
        passed_tests: 0,
        destructive_failures: 0
      }
    },
    {
      stats: {
        total_tests: 12,
        passed_tests: 8,
        destructive_failures: 1
      }
    },
    {
      stats: {
        total_tests: 40,
        passed_tests: 34,
        destructive_failures: 0
      }
    }
  ];

  const ts = loadInversion(false);
  const rust = loadInversion(true);
  for (const [idx, state] of states.entries()) {
    const tsOut = ts.computeMaturityScore(state, policy);
    const rustOut = rust.computeMaturityScore(state, policy);
    assert.deepStrictEqual(
      rustOut,
      tsOut,
      `computeMaturityScore parity mismatch sample ${idx + 1}: ts=${JSON.stringify(tsOut)} rust=${JSON.stringify(rustOut)}`
    );
  }

  console.log('inversion_maturity_score_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`inversion_maturity_score_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
