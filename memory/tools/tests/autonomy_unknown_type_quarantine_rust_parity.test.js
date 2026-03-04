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

function normalize(out) {
  const row = out && typeof out === 'object' ? out : {};
  return {
    block: row.block === true,
    proposal_type: row.proposal_type == null ? null : String(row.proposal_type),
    reason: row.reason == null ? null : String(row.reason),
    objective_id: row.objective_id == null ? null : String(row.objective_id)
  };
}

function run() {
  const ts = loadAutonomy(false);
  const rust = loadAutonomy(true);

  const proposal = {
    id: 'p-unknown-1',
    type: 'unknown_type',
    meta: {
      objective_id: 'T3_demo'
    }
  };

  const tsOut = normalize(ts.proposalUnknownTypeQuarantineDecision(proposal, null));
  const rustOut = normalize(rust.proposalUnknownTypeQuarantineDecision(proposal, null));
  assert.deepStrictEqual(rustOut, tsOut, 'proposalUnknownTypeQuarantineDecision mismatch');

  console.log('autonomy_unknown_type_quarantine_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_unknown_type_quarantine_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
