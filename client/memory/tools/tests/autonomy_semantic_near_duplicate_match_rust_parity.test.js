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

function buildCase() {
  return {
    fingerprint: {
      proposal_id: 'new-1',
      proposal_type: 'ops_remediation',
      source_eye: 'github_release',
      objective_id: 'obj_a',
      token_stems: ['rust', 'bridge', 'parity'],
      eligible: true
    },
    seen: [
      {
        proposal_id: 'old-1',
        proposal_type: 'ops_remediation',
        source_eye: 'github_release',
        objective_id: 'obj_a',
        token_stems: ['rust', 'bridge', 'tests'],
        eligible: true
      },
      {
        proposal_id: 'old-2',
        proposal_type: 'ops_remediation',
        source_eye: 'github_release',
        objective_id: 'obj_a',
        token_stems: ['rust', 'bridge', 'parity'],
        eligible: true
      }
    ]
  };
}

function run() {
  const tsController = loadController(false);
  const rustController = loadController(true);

  const row = buildCase();
  const tsOut = tsController.semanticNearDuplicateMatch(row.fingerprint, row.seen, 0.5);
  const rustOut = rustController.semanticNearDuplicateMatch(row.fingerprint, row.seen, 0.5);
  assert.deepStrictEqual(rustOut, tsOut, 'semanticNearDuplicateMatch parity mismatch');

  const noMatchTs = tsController.semanticNearDuplicateMatch(row.fingerprint, row.seen, 1.01);
  const noMatchRust = rustController.semanticNearDuplicateMatch(row.fingerprint, row.seen, 1.01);
  assert.deepStrictEqual(noMatchRust, noMatchTs, 'semanticNearDuplicateMatch no-match parity mismatch');

  console.log('autonomy_semantic_near_duplicate_match_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_semantic_near_duplicate_match_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
