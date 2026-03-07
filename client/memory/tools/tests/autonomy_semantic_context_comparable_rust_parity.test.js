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
    [
      { proposal_type: 'ops_remediation', source_eye: 'github_release', objective_id: 'obj_a' },
      { proposal_type: 'ops_remediation', source_eye: 'github_release', objective_id: 'obj_b' }
    ],
    [
      { proposal_type: 'feature', source_eye: 'reddit_ai_agents', objective_id: 'obj_a' },
      { proposal_type: 'ops_remediation', source_eye: 'reddit_ai_agents', objective_id: 'obj_a' }
    ],
    [
      { proposal_type: 'feature', source_eye: 'hn_frontpage', objective_id: 'obj_a' },
      { proposal_type: 'feature', source_eye: 'github_release', objective_id: 'obj_z' }
    ]
  ];

  const tsController = loadController(false);
  const rustController = loadController(true);

  for (const [left, right] of rows) {
    const tsOut = tsController.semanticContextComparable(left, right);
    const rustOut = rustController.semanticContextComparable(left, right);
    assert.strictEqual(
      rustOut,
      tsOut,
      `semanticContextComparable parity mismatch for ${JSON.stringify({ left, right })}`
    );
  }

  console.log('autonomy_semantic_context_comparable_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_semantic_context_comparable_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
