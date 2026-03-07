#!/usr/bin/env node
'use strict';

/**
 * Runtime lane for SYSTEMS-PRIMITIVES-CANONICAL-EVENT-LOG.
 * Native execution delegated through conduit to Rust kernel runtime.
 */

const fs = require('fs');
const path = require('path');

function findRepoRoot(startDir) {
  let dir = path.resolve(startDir || process.cwd());
  while (true) {
    if (
      fs.existsSync(path.join(dir, 'Cargo.toml'))
      && (
        fs.existsSync(path.join(dir, 'core', 'layer0', 'ops', 'Cargo.toml'))
        || fs.existsSync(path.join(dir, 'crates', 'ops', 'Cargo.toml'))
      )
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return process.cwd();
    dir = parent;
  }
}

const ROOT = findRepoRoot(__dirname);
const { createConduitLaneModule } = require(path.join(ROOT, 'client', 'lib', 'direct_conduit_lane_bridge.js'));

const lane = createConduitLaneModule('SYSTEMS-PRIMITIVES-CANONICAL-EVENT-LOG', ROOT);
const { LANE_ID, buildLaneReceipt, verifyLaneReceipt } = lane;

module.exports = lane;

if (require.main === module) {
  buildLaneReceipt()
    .then((row) => {
      console.log(JSON.stringify(row, null, 2));
      process.exit(row && row.ok === true ? 0 : 1);
    })
    .catch((err) => {
      console.error(
        JSON.stringify(
          {
            ok: false,
            type: 'conduit_lane_bridge_error',
            lane_id: LANE_ID,
            error: String(err && err.message ? err.message : err),
          },
          null,
          2,
        ),
      );
      process.exit(1);
    });
}

export {};
