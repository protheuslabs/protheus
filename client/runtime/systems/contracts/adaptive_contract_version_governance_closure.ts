#!/usr/bin/env node
'use strict';

// Layer ownership: core/layer2/ops (authoritative)
// Thin TypeScript wrapper only.

const { createOpsLaneBridge } = require('../../lib/rust_lane_bridge.ts');

const bridge = createOpsLaneBridge(
  __dirname,
  'adaptive_contract_version_governance',
  'adaptive-contract-version-governance'
);

function cmdRun(args = []) {
  const out = bridge.run(['run', ...Array.isArray(args) ? args : []]);
  return out && out.payload && typeof out.payload === 'object'
    ? out.payload
    : { ok: false, error: 'adaptive_contract_version_governance_bridge_failed' };
}

function cmdStatus(args = []) {
  const out = bridge.run(['status', ...Array.isArray(args) ? args : []]);
  return out && out.payload && typeof out.payload === 'object'
    ? out.payload
    : { ok: false, error: 'adaptive_contract_version_governance_bridge_failed' };
}

if (require.main === module) {
  bridge.runCli(process.argv.slice(2));
}

module.exports = {
  cmdRun,
  cmdStatus
};
