#!/usr/bin/env node
'use strict';

// Layer ownership: core/layer2/ops + core/layer0/ops::autophagy-auto-approval (authoritative)
// Thin wrapper only; authority logic lives in Rust.
const { createOpsLaneBridge } = require('../../lib/rust_lane_bridge');

process.env.PROTHEUS_OPS_LOCAL_FALLBACK = process.env.PROTHEUS_OPS_LOCAL_FALLBACK || '0';
process.env.PROTHEUS_OPS_DOMAIN_BRIDGE_TIMEOUT_MS =
  process.env.PROTHEUS_OPS_DOMAIN_BRIDGE_TIMEOUT_MS || '12000';

const bridge = createOpsLaneBridge(
  __dirname,
  'autophagy_auto_approval',
  'autophagy-auto-approval'
);

if (require.main === module) {
  bridge.runCli(process.argv.slice(2));
}

module.exports = {
  lane: bridge.lane,
  run: bridge.run
};
