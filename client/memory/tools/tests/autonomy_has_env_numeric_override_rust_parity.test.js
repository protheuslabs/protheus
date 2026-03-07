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
  const key = 'AUTONOMY_TEST_OVERRIDE_TMP';
  const original = process.env[key];
  try {
    process.env[key] = ' 123 ';
    const ts = loadAutonomy(false);
    const rust = loadAutonomy(true);
    assert.strictEqual(rust.hasEnvNumericOverride(key), ts.hasEnvNumericOverride(key), 'hasEnvNumericOverride present mismatch');

    process.env[key] = '   ';
    const ts2 = loadAutonomy(false);
    const rust2 = loadAutonomy(true);
    assert.strictEqual(rust2.hasEnvNumericOverride(key), ts2.hasEnvNumericOverride(key), 'hasEnvNumericOverride blank mismatch');

    delete process.env[key];
    const ts3 = loadAutonomy(false);
    const rust3 = loadAutonomy(true);
    assert.strictEqual(rust3.hasEnvNumericOverride(key), ts3.hasEnvNumericOverride(key), 'hasEnvNumericOverride missing mismatch');
  } finally {
    if (original == null) delete process.env[key];
    else process.env[key] = original;
  }

  console.log('autonomy_has_env_numeric_override_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_has_env_numeric_override_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
