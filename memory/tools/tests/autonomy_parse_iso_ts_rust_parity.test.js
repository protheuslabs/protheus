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

function normalizeDate(d) {
  if (!d) return null;
  const ms = d.getTime();
  return Number.isFinite(ms) ? ms : null;
}

function run() {
  const samples = [undefined, null, '', '2026-03-01T00:00:00.000Z', 'not-a-date'];

  const tsController = loadController(false);
  const rustController = loadController(true);

  for (const sample of samples) {
    const tsOut = normalizeDate(tsController.parseIsoTs(sample));
    const rustOut = normalizeDate(rustController.parseIsoTs(sample));
    assert.strictEqual(
      rustOut,
      tsOut,
      `parseIsoTs parity mismatch for ${JSON.stringify(sample)}: ts=${tsOut} rust=${rustOut}`
    );
  }

  console.log('autonomy_parse_iso_ts_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_parse_iso_ts_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
