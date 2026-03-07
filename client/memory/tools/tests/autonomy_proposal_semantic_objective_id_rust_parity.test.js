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
    meta: {
      objective_id: '',
      directive_objective_id: 'T1_DIRECTIVE',
      linked_objective_id: 'T2_LINKED'
    },
    suggested_next_command: 'node client/systems/security/directive_intake.js validate --id=T3_CMD',
    suggested_command: 'node x --id=T4_FALLBACK'
  };

  const ts = loadAutonomy(false);
  const rust = loadAutonomy(true);
  const tsOut = String(ts.proposalSemanticObjectiveId(proposal));
  const rustOut = String(rust.proposalSemanticObjectiveId(proposal));
  assert.strictEqual(rustOut, tsOut, 'proposalSemanticObjectiveId mismatch');

  console.log('autonomy_proposal_semantic_objective_id_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_proposal_semantic_objective_id_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
