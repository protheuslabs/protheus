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
      textTokens: new Set(['memory', 'drift']),
      textStems: new Set(['memor', 'drift']),
      directiveTokens: ['memory', 'memorize', 'security']
    },
    {
      textTokens: new Set(['route', 'policy']),
      textStems: new Set(['route', 'polic']),
      directiveTokens: ['routes', 'policy', 'safety']
    },
    {
      textTokens: new Set([]),
      textStems: new Set([]),
      directiveTokens: ['alpha', 'beta']
    }
  ];

  const tsController = loadController(false);
  const rustController = loadController(true);

  for (const row of rows) {
    const tsOut = tsController.directiveTokenHits(row.textTokens, row.textStems, row.directiveTokens);
    const rustOut = rustController.directiveTokenHits(row.textTokens, row.textStems, row.directiveTokens);
    assert.deepStrictEqual(
      rustOut,
      tsOut,
      `directiveTokenHits parity mismatch for ${JSON.stringify({ directiveTokens: row.directiveTokens })}`
    );
  }

  console.log('autonomy_directive_token_hits_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_directive_token_hits_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
