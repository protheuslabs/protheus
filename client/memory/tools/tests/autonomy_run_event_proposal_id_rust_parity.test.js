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
    { proposal_id: '  p-001  ', selected_proposal_id: 'p-002' },
    { proposal_id: '', selected_proposal_id: ' selected   proposal  ' },
    { proposal_id: 0, selected_proposal_id: 'p-009' },
    { proposal_id: [], selected_proposal_id: 'p-011' },
    { top_escalation: { proposal_id: '  escalated-7  ' } },
    {}
  ];

  for (const evt of cases) {
    const tsVal = loadController(false).runEventProposalId(evt);
    const rustVal = loadController(true).runEventProposalId(evt);
    assert.strictEqual(
      rustVal,
      tsVal,
      `runEventProposalId parity mismatch for ${JSON.stringify(evt)}`
    );
  }

  console.log('autonomy_run_event_proposal_id_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_run_event_proposal_id_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
