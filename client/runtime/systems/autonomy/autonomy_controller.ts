#!/usr/bin/env node
'use strict';
export {};

// Layer ownership: core/layer2/autonomy + core/layer0/ops::autonomy-controller (authoritative)
const { createOpsLaneBridge } = require('../../lib/rust_lane_bridge');

process.env.PROTHEUS_OPS_LOCAL_FALLBACK = process.env.PROTHEUS_OPS_LOCAL_FALLBACK || '0';
process.env.PROTHEUS_OPS_DOMAIN_BRIDGE_TIMEOUT_MS =
  process.env.PROTHEUS_OPS_DOMAIN_BRIDGE_TIMEOUT_MS || '12000';

const bridge = createOpsLaneBridge(__dirname, 'autonomy_controller', 'autonomy-controller');

if (require.main === module) {
  bridge.runCli(process.argv.slice(2));
}

module.exports = {
  lane: bridge.lane,
  run: bridge.run
};
