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

function normalize(raw) {
  const row = raw && typeof raw === 'object' ? raw : {};
  return {
    required: row.required === true,
    min_count: Number(row.min_count || 0),
    exempt: row.exempt === true
  };
}

function run() {
  const proposal = { type: 'directive_clarification' };
  const ts = loadAutonomy(false);
  const rust = loadAutonomy(true);

  const tsOut = normalize(ts.successCriteriaPolicyForProposal(proposal));
  const rustOut = normalize(rust.successCriteriaPolicyForProposal(proposal));
  assert.deepStrictEqual(rustOut, tsOut, 'successCriteriaPolicyForProposal mismatch');

  console.log('autonomy_success_criteria_policy_for_proposal_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_success_criteria_policy_for_proposal_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
