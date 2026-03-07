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
    'Memory++ Drift\\nPlan!',
    '  Safety-first, always.  ',
    'A_B_C 123',
    'multi\tspace\nline'
  ];

  const tsController = loadController(false);
  const rustController = loadController(true);

  for (const sample of samples) {
    const tsOut = tsController.normalizeDirectiveText(sample);
    const rustOut = rustController.normalizeDirectiveText(sample);
    assert.strictEqual(
      rustOut,
      tsOut,
      `normalizeDirectiveText parity mismatch for ${JSON.stringify(sample)}: ts=${tsOut} rust=${rustOut}`
    );
  }

  console.log('autonomy_normalize_directive_text_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_normalize_directive_text_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
