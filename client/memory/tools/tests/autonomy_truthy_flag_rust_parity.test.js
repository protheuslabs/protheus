#!/usr/bin/env node
'use strict';

const path = require('path');
const assert = require('assert');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const autonomyPath = path.join(REPO_ROOT, 'systems', 'autonomy', 'autonomy_controller.js');
const bridgePath = path.join(REPO_ROOT, 'systems', 'autonomy', 'backlog_autoscale_rust_bridge.js');

function loadAutonomy(rustEnabled) {
  process.env.AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED = rustEnabled ? '1' : '0';
  delete require.cache[autonomyPath];
  delete require.cache[bridgePath];
  return require(autonomyPath);
}

function run() {
  const samples = [true, false, null, undefined, 'true', 'yes', '1', '0', 1, 0, 'no', 'maybe'];
  const ts = loadAutonomy(false);
  const rust = loadAutonomy(true);
  for (const sample of samples) {
    const tsOut = ts.truthyFlag(sample);
    const rustOut = rust.truthyFlag(sample);
    assert.deepStrictEqual(rustOut, tsOut, `truthyFlag mismatch for sample=${String(sample)}`);
  }
  console.log('autonomy_truthy_flag_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_truthy_flag_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
