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
  const originalArgv = process.argv.slice();
  process.argv = ['node', 'script.js', '--date=2026-03-04', '--mode=run'];
  try {
    const ts = loadAutonomy(false);
    const rust = loadAutonomy(true);

    const tsOut = ts.parseArg('date');
    const rustOut = rust.parseArg('date');
    assert.strictEqual(rustOut, tsOut, 'parseArg mismatch for date');

    const tsMissing = ts.parseArg('missing');
    const rustMissing = rust.parseArg('missing');
    assert.strictEqual(rustMissing, tsMissing, 'parseArg mismatch for missing arg');
  } finally {
    process.argv = originalArgv;
  }

  console.log('autonomy_parse_arg_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_parse_arg_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
