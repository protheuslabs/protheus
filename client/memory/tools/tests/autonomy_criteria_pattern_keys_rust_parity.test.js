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
  const proposal = {
    type: 'directive_clarification',
    summary: 'Improve latency and quality signals',
    validation: ['latency_ms <= 200', 'quality score >= 90'],
    action_spec: {
      success_criteria: ['latency_ms <= 200', 'quality score >= 90']
    }
  };

  const ts = loadAutonomy(false);
  const rust = loadAutonomy(true);

  const tsOut = ts.criteriaPatternKeysForProposal(proposal, 'actuation:run');
  const rustOut = rust.criteriaPatternKeysForProposal(proposal, 'actuation:run');
  assert.deepStrictEqual(rustOut, tsOut, 'criteriaPatternKeysForProposal mismatch');

  console.log('autonomy_criteria_pattern_keys_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_criteria_pattern_keys_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
