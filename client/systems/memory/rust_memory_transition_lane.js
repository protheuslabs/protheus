#!/usr/bin/env node
'use strict';

const { createManifestLaneBridge } = require('../../lib/rust_lane_bridge');

const bridge = createManifestLaneBridge(__dirname, 'rust_memory_transition_lane', {
  manifestPath: 'client/systems/memory/rust/Cargo.toml',
  binaryName: 'rust_memory_transition_lane',
  binaryEnvVar: 'PROTHEUS_MEMORY_TRANSITION_RUST_BIN',
  inheritStdio: true
});

if (require.main === module) {
  bridge.runCli(process.argv.slice(2));
}

module.exports = {
  lane: bridge.lane,
  run: bridge.run
};
