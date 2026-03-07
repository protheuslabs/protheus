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
      a: ['rust', 'bridge', 'parity'],
      b: ['rust', 'parity', 'tests']
    },
    {
      a: ['alpha', 'beta', 'beta', 'gamma'],
      b: ['beta', 'gamma', 'delta']
    },
    {
      a: ['only-left'],
      b: []
    }
  ];

  const tsController = loadController(false);
  const rustController = loadController(true);

  for (const c of cases) {
    const tsOut = tsController.semanticTokenSimilarity(c.a, c.b);
    const rustOut = rustController.semanticTokenSimilarity(c.a, c.b);
    assert.strictEqual(
      rustOut,
      tsOut,
      `semanticTokenSimilarity parity mismatch for ${JSON.stringify(c)}`
    );
  }

  console.log('autonomy_semantic_token_similarity_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_semantic_token_similarity_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
