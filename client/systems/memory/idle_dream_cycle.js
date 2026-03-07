#!/usr/bin/env node
'use strict';

const { createManifestLaneBridge } = require('../../lib/rust_lane_bridge');

const bridge = createManifestLaneBridge(__dirname, 'idle_dream_cycle', {
  manifestPath: 'client/systems/memory/rust/Cargo.toml',
  binaryName: 'idle_dream_cycle',
  binaryEnvVar: 'PROTHEUS_IDLE_DREAM_RUST_BIN',
  inheritStdio: true
});

if (require.main === module) {
  bridge.runCli(process.argv.slice(2));
}

module.exports = {
  lane: bridge.lane,
  run: bridge.run
};
