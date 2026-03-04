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

function verificationSample(label, primaryFailure, criteria) {
  return {
    label,
    payload: {
      primary_failure: primaryFailure,
      success_criteria: criteria
    }
  };
}

function run() {
  const samples = [
    verificationSample('primary failure match', 'metric_not_allowed_for_capability', {
      contract_not_allowed_count: 0,
      unsupported_count: 0,
      total_count: 0
    }),
    verificationSample('contract not allowed count', '', {
      contract_not_allowed_count: 1,
      unsupported_count: 0,
      total_count: 2
    }),
    verificationSample('unsupported rate threshold', '', {
      contract_not_allowed_count: 0,
      unsupported_count: 2,
      total_count: 3
    }),
    verificationSample('passes when below thresholds', '', {
      contract_not_allowed_count: 0,
      unsupported_count: 1,
      total_count: 4
    })
  ];

  for (const sample of samples) {
    const tsOut = loadController(false).hasStructuralPreviewCriteriaFailure(sample.payload);
    const rustOut = loadController(true).hasStructuralPreviewCriteriaFailure(sample.payload);
    assert.strictEqual(
      rustOut,
      tsOut,
      `hasStructuralPreviewCriteriaFailure parity mismatch (${sample.label})`
    );
  }

  console.log('autonomy_structural_preview_criteria_failure_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_structural_preview_criteria_failure_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
