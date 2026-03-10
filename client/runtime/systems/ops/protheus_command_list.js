#!/usr/bin/env node
'use strict';

// Layer ownership: core/layer2/ops + core/layer0/ops::legacy-retired-lane (authoritative)
// Thin wrapper only; historical TS authority retired to Rust lane receipts.
const { createOpsLaneBridge } = require('../../lib/rust_lane_bridge');

process.env.PROTHEUS_CONDUIT_STARTUP_PROBE = '0';
process.env.PROTHEUS_CONDUIT_COMPAT_FALLBACK = '0';
process.env.PROTHEUS_OPS_DOMAIN_BRIDGE_TIMEOUT_MS =
  process.env.PROTHEUS_OPS_DOMAIN_BRIDGE_TIMEOUT_MS || '15000';
process.env.PROTHEUS_OPS_LOCAL_TIMEOUT_MS =
  process.env.PROTHEUS_OPS_LOCAL_TIMEOUT_MS || '20000';

const LANE_ID = 'SYSTEMS-OPS-PROTHEUS-COMMAND-LIST';
const bridge = createOpsLaneBridge(__dirname, 'protheus_command_list', 'legacy-retired-lane');

function mapArgs(args = []) {
  const cmd = String((Array.isArray(args) && args[0]) || '').trim().toLowerCase();
  if (cmd === 'status' || cmd === 'verify') {
    return ['verify', '--lane-id=' + LANE_ID];
  }
  return ['build', '--lane-id=' + LANE_ID];
}

function runCore(args = []) {
  const out = bridge.run(mapArgs(args));
  if (out && out.stdout) process.stdout.write(out.stdout);
  if (out && out.stderr) process.stderr.write(out.stderr);
  if (out && out.payload && !out.stdout) process.stdout.write(JSON.stringify(out.payload) + '\n');
  return out;
}

if (require.main === module) {
  const out = runCore(process.argv.slice(2));
  process.exit(Number.isFinite(out && out.status) ? Number(out.status) : 1);
}

module.exports = {
  lane: bridge.lane,
  run: (args = []) => bridge.run(mapArgs(args))
};
