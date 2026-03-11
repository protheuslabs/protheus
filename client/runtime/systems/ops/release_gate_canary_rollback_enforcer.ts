#!/usr/bin/env node
'use strict';

// Layer ownership: core/layer2/ops (authoritative)
// Thin TypeScript wrapper only.

const { createOpsLaneBridge } = require('../../lib/rust_lane_bridge.ts');

const bridge = createOpsLaneBridge(
  __dirname,
  'release_gate_canary_rollback_enforcer',
  'release-gate-canary-rollback-enforcer'
);

function cmdGate(args = []) {
  const out = bridge.run(['gate', ...Array.isArray(args) ? args : []]);
  return out && out.payload && typeof out.payload === 'object'
    ? out.payload
    : { ok: false, error: 'release_gate_canary_rollback_enforcer_bridge_failed' };
}

function cmdStatus(args = []) {
  const out = bridge.run(['status', ...Array.isArray(args) ? args : []]);
  return out && out.payload && typeof out.payload === 'object'
    ? out.payload
    : { ok: false, error: 'release_gate_canary_rollback_enforcer_bridge_failed' };
}

if (require.main === module) {
  bridge.runCli(process.argv.slice(2));
}

module.exports = {
  cmdGate,
  cmdStatus
};
