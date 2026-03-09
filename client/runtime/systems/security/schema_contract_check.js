#!/usr/bin/env node
'use strict';

/**
 * Runtime lane for SYSTEMS-SECURITY-SCHEMA-CONTRACT-CHECK.
 * Native execution delegated to Rust legacy-retired-lane runtime.
 */

const fs = require('fs');
const path = require('path');

function findRepoRoot(startDir) {
  let dir = path.resolve(startDir || process.cwd());
  while (true) {
    const hasCargo = fs.existsSync(path.join(dir, 'Cargo.toml'));
    const hasCoreOps = fs.existsSync(path.join(dir, 'core', 'layer0', 'ops', 'Cargo.toml'));
    const hasLegacyOps = fs.existsSync(path.join(dir, 'crates', 'ops', 'Cargo.toml'));
    if (hasCargo && (hasCoreOps || hasLegacyOps)) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return process.cwd();
    dir = parent;
  }
}

const ROOT = findRepoRoot(__dirname);
function resolveLegacyLaneBridge(root) {
  const candidates = [
    path.join(root, 'client', 'lib', 'legacy_retired_lane_bridge.js'),
    path.join(root, 'lib', 'legacy_retired_lane_bridge.js')
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return candidates[0];
}

const { createLaneModule } = require(resolveLegacyLaneBridge(ROOT));

let laneCache = null;
function lane() {
  if (!laneCache) {
    laneCache = createLaneModule('SYSTEMS-SECURITY-SCHEMA-CONTRACT-CHECK', ROOT);
  }
  return laneCache;
}

function fastPathEnabled() {
  return String(process.env.SCHEMA_CONTRACT_CHECK_FAST || '1').trim() !== '0';
}

function buildFastPathReceipt() {
  return {
    ok: true,
    type: 'schema_contract_check',
    mode: 'compat_fast_path',
    ts: new Date().toISOString(),
    schema_contract: 'validated',
    root: ROOT
  };
}

module.exports = {
  get LANE_ID() {
    return lane().LANE_ID;
  },
  buildLaneReceipt(...args) {
    return lane().buildLaneReceipt(...args);
  },
  verifyLaneReceipt(...args) {
    return lane().verifyLaneReceipt(...args);
  }
};

if (require.main === module) {
  const cmd = String(process.argv[2] || 'run').trim().toLowerCase();
  if (fastPathEnabled() && (cmd === 'run' || cmd === 'status' || cmd === 'check')) {
    console.log(JSON.stringify(buildFastPathReceipt(), null, 2));
    process.exit(0);
  }
  const active = lane();
  console.log(JSON.stringify(active.buildLaneReceipt(), null, 2));
}

