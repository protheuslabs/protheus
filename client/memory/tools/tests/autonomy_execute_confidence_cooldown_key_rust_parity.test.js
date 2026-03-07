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
  const samples = [
    {
      label: 'objective takes priority',
      capabilityKey: 'system_exec',
      objectiveId: 'T1_Objective',
      proposalType: 'ops_remediation'
    },
    {
      label: 'invalid objective falls back to capability',
      capabilityKey: 'system_exec',
      objectiveId: 'T12_Objective',
      proposalType: 'ops_remediation'
    },
    {
      label: 'capability fallback',
      capabilityKey: 'Core Planner',
      objectiveId: '',
      proposalType: 'ops_remediation'
    },
    {
      label: 'proposal type fallback',
      capabilityKey: '',
      objectiveId: '',
      proposalType: 'Directive Decomposition'
    },
    {
      label: 'empty input',
      capabilityKey: '',
      objectiveId: '',
      proposalType: ''
    }
  ];

  for (const sample of samples) {
    const tsOut = loadController(false).executeConfidenceCooldownKey(
      sample.capabilityKey,
      sample.objectiveId,
      sample.proposalType
    );
    const rustOut = loadController(true).executeConfidenceCooldownKey(
      sample.capabilityKey,
      sample.objectiveId,
      sample.proposalType
    );
    assert.strictEqual(
      rustOut,
      tsOut,
      `executeConfidenceCooldownKey parity mismatch (${sample.label})`
    );
  }

  console.log('autonomy_execute_confidence_cooldown_key_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_execute_confidence_cooldown_key_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
