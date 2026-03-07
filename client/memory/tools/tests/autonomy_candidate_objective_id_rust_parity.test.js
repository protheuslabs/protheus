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
  const cand = {
    directive_pulse: {
      objective_id: 'T1_growth_loop'
    }
  };
  const proposal = {
    objective_id: '',
    meta: {
      objective_id: 'T2_unused_meta',
      directive_objective_id: 'T3_unused_directive_meta'
    }
  };

  const ts = loadAutonomy(false);
  const rust = loadAutonomy(true);
  const tsOut = String(ts.candidateObjectiveId(cand, proposal) || '');
  const rustOut = String(rust.candidateObjectiveId(cand, proposal) || '');
  assert.strictEqual(rustOut, tsOut, 'candidateObjectiveId mismatch');

  console.log('autonomy_candidate_objective_id_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_candidate_objective_id_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
