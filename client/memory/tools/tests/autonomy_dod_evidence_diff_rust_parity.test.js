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
  const cases = [
    {
      label: 'standard growth',
      before: {
        daily: { artifacts: 3, entries: 5, revenue_actions: 1 },
        registry: { total: 8, active: 4, candidate: 4 },
        logs: { run_len: 6, error_len: 1 }
      },
      after: {
        daily: { artifacts: 6, entries: 8, revenue_actions: 2 },
        registry: { total: 9, active: 5, candidate: 4 },
        logs: { run_len: 9, error_len: 2 }
      }
    },
    {
      label: 'missing sections default to zero',
      before: {},
      after: {
        daily: { artifacts: 1 }
      }
    }
  ];

  for (const sample of cases) {
    const tsOut = loadController(false).diffDoDEvidence(sample.before, sample.after);
    const rustOut = loadController(true).diffDoDEvidence(sample.before, sample.after);
    assert.deepStrictEqual(
      rustOut,
      tsOut,
      `diffDoDEvidence parity mismatch (${sample.label})`
    );
  }

  console.log('autonomy_dod_evidence_diff_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_dod_evidence_diff_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
