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

function normalizeSet(s) {
  return Array.from(s || []).map((x) => String(x)).sort();
}

function run() {
  const ts = loadAutonomy(false);
  const rust = loadAutonomy(true);

  const strategyOverride = {
    risk_policy: {
      allowed_risks: ['low', 'high']
    }
  };

  const tsOut = normalizeSet(ts.effectiveAllowedRisksSet(strategyOverride));
  const rustOut = normalizeSet(rust.effectiveAllowedRisksSet(strategyOverride));
  assert.deepStrictEqual(rustOut, tsOut, 'effectiveAllowedRisksSet mismatch');

  console.log('autonomy_effective_allowed_risks_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_effective_allowed_risks_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
