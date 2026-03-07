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
  const scopes = [
    { scope_type: 'proposal_type', scope_value: 'ops_remediation' },
    { scope_type: 'capability_key', scope_value: 'system_exec' },
    { scope_type: 'objective_id', scope_value: 'obj-42' },
    { scope_type: 'global', risk_levels: ['high', 'medium'] },
    { scope_type: 'global', risk_levels: [] }
  ];
  const ctx = {
    risk: 'medium',
    proposal_type: 'ops_remediation',
    capability_key: 'system_exec',
    objective_id: 'obj-42'
  };

  const tsController = loadController(false);
  const rustController = loadController(true);

  for (const scope of scopes) {
    const tsOut = tsController.shadowScopeMatchesCandidate(scope, ctx);
    const rustOut = rustController.shadowScopeMatchesCandidate(scope, ctx);
    assert.strictEqual(
      rustOut,
      tsOut,
      `shadowScopeMatchesCandidate parity mismatch for ${JSON.stringify(scope)}`
    );
  }

  console.log('autonomy_shadow_scope_matches_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_shadow_scope_matches_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
