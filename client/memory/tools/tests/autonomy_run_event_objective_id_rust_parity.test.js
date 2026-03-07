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
    { directive_pulse: { objective_id: 'T1_primary' }, objective_id: 'T2_fallback' },
    { directive_pulse: { objective_id: '  ' }, objective_id: 'T1_secondary' },
    { directive_pulse: { objective_id: 0 }, objective_id: 'T1_numeric_fallback' },
    { objective_id: 'invalid-objective' },
    { objective_id: 'T2_valid_objective' },
    { objective_binding: { objective_id: 'T3_binding_choice' } },
    { top_escalation: { objective_id: 'T4_escalation_choice' } },
    { directive_pulse: { objective_id: [] }, objective_id: 'T1_should_not_fallback' }
  ];

  for (const evt of cases) {
    const tsVal = loadController(false).runEventObjectiveId(evt);
    const rustVal = loadController(true).runEventObjectiveId(evt);
    assert.strictEqual(
      rustVal,
      tsVal,
      `runEventObjectiveId parity mismatch for ${JSON.stringify(evt)}`
    );
  }

  console.log('autonomy_run_event_objective_id_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_run_event_objective_id_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
