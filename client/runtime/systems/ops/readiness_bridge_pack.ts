#!/usr/bin/env node
'use strict';

// Layer ownership: core/layer0/ops (authoritative)
// Thin TypeScript wrapper only.

const { createOpsLaneBridge } = require('../../lib/rust_lane_bridge.ts');

process.env.PROTHEUS_OPS_USE_PREBUILT = process.env.PROTHEUS_OPS_USE_PREBUILT || '0';
process.env.PROTHEUS_OPS_LOCAL_TIMEOUT_MS = process.env.PROTHEUS_OPS_LOCAL_TIMEOUT_MS || '120000';
const bridge = createOpsLaneBridge(__dirname, 'readiness_bridge_pack', 'readiness-bridge-pack-kernel');

function main(argv = process.argv.slice(2)) {
  const out = bridge.run(Array.isArray(argv) && argv.length ? argv : ['run']);
  if (out.stdout) process.stdout.write(out.stdout);
  if (out.stderr) process.stderr.write(out.stderr);
  return Number.isFinite(Number(out.status)) ? Number(out.status) : 1;
}

function runPack(strict = true, options = {}) {
  const args = ['run', `--strict=${strict ? 1 : 0}`];
  if (options && typeof options === 'object' && options.policy) {
    args.push(`--policy=${String(options.policy)}`);
  }
  const out = bridge.run(args);
  const receipt = out && out.payload && typeof out.payload === 'object' ? out.payload : null;
  return receipt && receipt.payload && typeof receipt.payload === 'object'
    ? receipt.payload
    : receipt;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = { main, runPack };
