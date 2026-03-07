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

function buildCases() {
  return [
    {
      type: 'ops_remediation',
      expected_impact: 'high',
      meta: {
        expected_value_score: 62,
        value_oracle_primary_currency: 'revenue',
        value_oracle_matched_currencies: ['revenue', 'delivery'],
        value_oracle_active_currencies: ['revenue'],
        value_oracle_matched_first_sentence_currencies: ['revenue'],
        value_oracle_applies: true,
        value_oracle_pass: true
      }
    },
    {
      type: 'feature',
      expected_impact: 'medium',
      meta: {
        expected_value_usd: 2500,
        value_oracle_priority_score: 72,
        value_oracle_primary_currency: 'delivery',
        value_oracle_matched_currencies: ['delivery'],
        value_oracle_active_currencies: ['delivery', 'quality'],
        value_oracle_matched_first_sentence_currencies: ['delivery'],
        value_oracle_applies: true,
        value_oracle_pass: true
      }
    },
    {
      type: 'feature',
      expected_impact: 'low',
      meta: {
        value_oracle_priority_score: 58,
        value_oracle_primary_currency: 'quality',
        value_oracle_matched_currencies: ['quality'],
        value_oracle_active_currencies: ['quality'],
        value_oracle_applies: true,
        value_oracle_pass: false
      }
    }
  ];
}

function run() {
  const rows = buildCases();
  const tsController = loadController(false);
  const rustController = loadController(true);

  for (const row of rows) {
    const tsOut = tsController.expectedValueSignalForProposal(row);
    const rustOut = rustController.expectedValueSignalForProposal(row);
    assert.deepStrictEqual(
      rustOut,
      tsOut,
      `expectedValueSignalForProposal parity mismatch for ${JSON.stringify(row)}`
    );
  }

  console.log('autonomy_expected_value_signal_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_expected_value_signal_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
