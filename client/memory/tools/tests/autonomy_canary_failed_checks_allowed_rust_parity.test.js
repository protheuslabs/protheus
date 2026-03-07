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
    { failed: ['lint', 'format'], allowed: new Set(['lint', 'format', 'typecheck']) },
    { failed: ['lint', 'security'], allowed: new Set(['lint', 'format']) },
    { failed: [], allowed: new Set(['lint']) },
    { failed: ['lint'], allowed: new Set() }
  ];

  const tsController = loadController(false);
  const rustController = loadController(true);

  for (const row of rows) {
    const tsOut = tsController.canaryFailedChecksAllowed(row.failed, row.allowed);
    const rustOut = rustController.canaryFailedChecksAllowed(row.failed, row.allowed);
    assert.strictEqual(
      rustOut,
      tsOut,
      `canaryFailedChecksAllowed parity mismatch for ${JSON.stringify({ failed: row.failed, allowed: Array.from(row.allowed) })}: ts=${tsOut} rust=${rustOut}`
    );
  }

  console.log('autonomy_canary_failed_checks_allowed_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_canary_failed_checks_allowed_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
