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
  const req = row.required && typeof row.required === 'object' ? row.required : null;
  return {
    pass: row.pass === true,
    risk: String(row.risk || ''),
    reasons: Array.isArray(row.reasons) ? row.reasons.map(String).sort() : [],
    required: req
      ? {
          composite_min: Number(req.composite_min || 0),
          directive_fit_min: Number(req.directive_fit_min || 0),
          actionability_min: Number(req.actionability_min || 0)
        }
      : null
  };
}

function run() {
  const ts = loadAutonomy(false);
  const rust = loadAutonomy(true);

  const proposal = { risk: 'medium' };
  const base = { min_directive_fit: 42, min_actionability_score: 48 };

  const tsOut = normalize(ts.mediumRiskGateDecision(proposal, 50, 49, 60, base));
  const rustOut = normalize(rust.mediumRiskGateDecision(proposal, 50, 49, 60, base));
  assert.deepStrictEqual(rustOut, tsOut, 'mediumRiskGateDecision mismatch');

  console.log('autonomy_medium_risk_gate_decision_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_medium_risk_gate_decision_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
