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
  const samples = [
    undefined,
    null,
    '',
    'The memory plan 123 avoids drift',
    'A_B_C with   multiple\\nspaces and 42 numbers',
    'ops security routing'
  ];

  const tsController = loadController(false);
  const rustController = loadController(true);

  for (const sample of samples) {
    const tsOut = tsController.tokenizeDirectiveText(sample);
    const rustOut = rustController.tokenizeDirectiveText(sample);
    assert.deepStrictEqual(
      rustOut,
      tsOut,
      `tokenizeDirectiveText parity mismatch for ${JSON.stringify(sample)}: ts=${JSON.stringify(tsOut)} rust=${JSON.stringify(rustOut)}`
    );
  }

  console.log('autonomy_tokenize_directive_text_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_tokenize_directive_text_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
