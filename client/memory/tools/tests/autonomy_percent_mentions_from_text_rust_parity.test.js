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
    '',
    'improve by 12.5% then -2% then 140%',
    'target 25% and 50% and 75%',
    'no percentages here'
  ];

  const tsController = loadController(false);
  const rustController = loadController(true);

  for (const sample of samples) {
    const tsOut = tsController.percentMentionsFromText(sample);
    const rustOut = rustController.percentMentionsFromText(sample);
    assert.deepStrictEqual(
      rustOut,
      tsOut,
      `percentMentionsFromText parity mismatch for ${JSON.stringify(sample)}: ts=${JSON.stringify(tsOut)} rust=${JSON.stringify(rustOut)}`
    );
  }

  console.log('autonomy_percent_mentions_from_text_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_percent_mentions_from_text_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
