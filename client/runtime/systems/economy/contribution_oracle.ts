#!/usr/bin/env node
'use strict';

// Layer ownership: core/layer2/ops (authoritative)
// Thin TypeScript wrapper only.

const { createOpsLaneBridge } = require('../../lib/rust_lane_bridge.ts');

const bridge = createOpsLaneBridge(__dirname, 'contribution_oracle', 'contribution-oracle');

function validateContribution(input = {}) {
  const out = bridge.run([
    'validate',
    `--input-json=${JSON.stringify(input && typeof input === 'object' ? input : {})}`
  ]);
  if (out && out.payload && typeof out.payload === 'object') {
    return out.payload;
  }
  return {
    ok: false,
    validated: false,
    errors: ['contribution_oracle_bridge_failed']
  };
}

if (require.main === module) {
  bridge.runCli(process.argv.slice(2));
}

module.exports = {
  validateContribution
};
