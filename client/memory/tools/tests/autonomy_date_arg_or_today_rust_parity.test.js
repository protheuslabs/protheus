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
  const ts = loadAutonomy(false);
  const rust = loadAutonomy(true);

  const valid = '2026-03-04';
  assert.strictEqual(rust.dateArgOrToday(valid), ts.dateArgOrToday(valid), 'dateArgOrToday valid mismatch');

  const invalid = 'not-a-date';
  assert.strictEqual(rust.dateArgOrToday(invalid), ts.dateArgOrToday(invalid), 'dateArgOrToday fallback mismatch');

  console.log('autonomy_date_arg_or_today_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_date_arg_or_today_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
