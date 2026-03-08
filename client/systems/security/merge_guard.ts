#!/usr/bin/env node
'use strict';

/**
 * Runtime lane for SYSTEMS-SECURITY-MERGE-GUARD.
 * Native execution delegated to Rust legacy-retired-lane runtime.
 */

const fs = require('fs');
const path = require('path');

function findRepoRoot(startDir) {
  let dir = path.resolve(startDir || process.cwd());
  while (true) {
    const hasCargo = fs.existsSync(path.join(dir, 'Cargo.toml'));
    const hasOps = fs.existsSync(path.join(dir, 'core', 'layer0', 'ops', 'Cargo.toml'))
      || fs.existsSync(path.join(dir, 'crates', 'ops', 'Cargo.toml'));
    if (hasCargo && hasOps) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return process.cwd();
    dir = parent;
  }
}

const ROOT = findRepoRoot(__dirname);
const legacyBridgePath = fs.existsSync(path.join(ROOT, 'client', 'lib', 'legacy_retired_lane_bridge.js'))
  ? path.join(ROOT, 'client', 'lib', 'legacy_retired_lane_bridge.js')
  : path.join(ROOT, 'lib', 'legacy_retired_lane_bridge.js');
const { createLaneModule } = require(legacyBridgePath);

const lane = createLaneModule('SYSTEMS-SECURITY-MERGE-GUARD', ROOT);
const { LANE_ID, buildLaneReceipt, verifyLaneReceipt } = lane;

module.exports = lane;

if (require.main === module) {
  console.log(JSON.stringify(buildLaneReceipt(), null, 2));
}

export {};
