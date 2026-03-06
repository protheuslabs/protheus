#!/usr/bin/env node
'use strict';
export {};

const { createOpsLaneBridge } = require('../../lib/rust_lane_bridge');

const bridge = createOpsLaneBridge(__dirname, 'rust_enterprise_productivity_program', 'rust-enterprise-productivity-program');

if (require.main === module) {
  bridge.runCli(process.argv.slice(2));
}

module.exports = {
  lane: bridge.lane,
  run: bridge.run
};
