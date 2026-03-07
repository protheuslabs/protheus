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

function makeProposal(idx) {
  return {
    id: `value-signal-${idx}`,
    type: 'ops_remediation',
    risk: idx % 2 === 0 ? 'medium' : 'low',
    expected_impact: idx % 3 === 0 ? 'high' : idx % 3 === 1 ? 'medium' : 'low',
    title: `Remediate lane ${idx}`,
    summary: 'Improve execution reliability',
    action_spec: {
      command: 'node client/systems/ops/protheusctl.js status',
      verify: ['status check'],
      rollback_command: 'echo rollback'
    },
    validation: ['verify queue health']
  };
}

function run() {
  const actionabilityCases = [
    { score: 78 },
    { score: 62 },
    { score: 45 },
    { score: 91 }
  ];
  const directiveFitCases = [
    { score: 74 },
    { score: 58 },
    { score: 41 },
    { score: 88 }
  ];

  for (let i = 0; i < actionabilityCases.length; i += 1) {
    const proposal = makeProposal(i);
    const actionability = actionabilityCases[i];
    const directiveFit = directiveFitCases[i];

    const tsOut = loadController(false).assessValueSignal(proposal, actionability, directiveFit);
    const rustOut = loadController(true).assessValueSignal(proposal, actionability, directiveFit);

    assert.deepStrictEqual(
      rustOut,
      tsOut,
      `assessValueSignal parity mismatch for ${JSON.stringify(proposal)}`
    );
  }

  console.log('autonomy_assess_value_signal_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_assess_value_signal_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
