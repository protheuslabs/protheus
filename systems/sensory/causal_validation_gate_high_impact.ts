#!/usr/bin/env node
'use strict';

/**
 * Runtime lane for SYSTEMS-SENSORY-CAUSAL-VALIDATION-GATE-HIGH-IMPACT.
 * Native execution delegated to Rust legacy-retired-lane runtime.
 */

const fs = require('fs');
const path = require('path');

function findRepoRoot(startDir) {
  let dir = path.resolve(startDir || process.cwd());
  while (true) {
    if (fs.existsSync(path.join(dir, 'Cargo.toml')) && fs.existsSync(path.join(dir, 'crates', 'ops', 'Cargo.toml'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return process.cwd();
    dir = parent;
  }
}

const ROOT = findRepoRoot(__dirname);
const { createLaneModule } = require(path.join(ROOT, 'lib', 'legacy_retired_lane_bridge.js'));

const lane = createLaneModule('SYSTEMS-SENSORY-CAUSAL-VALIDATION-GATE-HIGH-IMPACT', ROOT);
const { LANE_ID, buildLaneReceipt, verifyLaneReceipt } = lane;

module.exports = lane;

if (require.main === module) {
  console.log(JSON.stringify(buildLaneReceipt(), null, 2));
}

export {};
