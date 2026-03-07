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

function makeProposal(id, title, summary) {
  return {
    id,
    type: 'ops_remediation',
    title,
    summary,
    suggested_next_command: 'node client/systems/ops/protheusctl.js status --id=T1_Objective',
    meta: {
      source_eye: 'github_release',
      objective_id: 'T1_Objective'
    }
  };
}

function run() {
  const samples = [
    makeProposal('p-1', 'Rust bridge parity checks', 'Transport failures and rollback'),
    makeProposal('p-2', 'Queue pressure normalization', 'Critical pending ratio exceeded')
  ];

  for (const proposal of samples) {
    const tsOut = loadController(false).proposalSemanticFingerprint(proposal);
    const rustOut = loadController(true).proposalSemanticFingerprint(proposal);
    assert.deepStrictEqual(
      rustOut,
      tsOut,
      `proposalSemanticFingerprint parity mismatch for ${proposal.id}`
    );
  }

  console.log('autonomy_proposal_semantic_fingerprint_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_proposal_semantic_fingerprint_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
