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
    {
      proposal_id: 'p-001',
      objective_id: 'T1_primary',
      objective_binding: { pass: true, required: true, source: 'pulse', valid: true }
    },
    {
      proposal_id: ' p-002 ',
      directive_pulse: { objective_id: 'T2_secondary' },
      objective_binding: { pass: false, required: false, source: '', valid: false }
    },
    {
      selected_proposal_id: 'selected-7',
      objective_binding: { pass: true, required: false, source: 'meta', valid: true }
    },
    {
      proposal_id: '',
      objective_id: '',
      objective_binding: { pass: true, required: true, source: 'ignored', valid: true }
    }
  ];

  for (const evt of cases) {
    const tsVal = loadController(false).deriveRepeatGateAnchor(evt);
    const rustVal = loadController(true).deriveRepeatGateAnchor(evt);
    assert.deepStrictEqual(
      rustVal,
      tsVal,
      `deriveRepeatGateAnchor parity mismatch for ${JSON.stringify(evt)}`
    );
  }

  console.log('autonomy_repeat_gate_anchor_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_repeat_gate_anchor_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
