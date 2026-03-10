#!/usr/bin/env node
'use strict';

/**
 * integrity_kernel.js
 *
 * Layer ownership: core/layer1/security::integrity-kernel (authoritative)
 * Client wrapper routes all actions through Rust lane only.
 */

const { createOpsLaneBridge } = require('../../lib/rust_lane_bridge');

process.env.PROTHEUS_OPS_DOMAIN_BRIDGE_TIMEOUT_MS =
  process.env.PROTHEUS_OPS_DOMAIN_BRIDGE_TIMEOUT_MS || '1500';
process.env.PROTHEUS_OPS_LOCAL_TIMEOUT_MS =
  process.env.PROTHEUS_OPS_LOCAL_TIMEOUT_MS || '2000';

const COMMAND = 'integrity-kernel';
const bridge = createOpsLaneBridge(__dirname, 'integrity_kernel', 'security-plane');

function runCore(args = []) {
  try {
    return bridge.run([COMMAND, ...(Array.isArray(args) ? args : [])]);
  } catch (error) {
    return {
      status: 1,
      stdout: '',
      stderr: String(error && error.message ? error.message : error),
      payload: {
        ok: false,
        type: 'integrity_kernel_core_error',
        error: String(error && error.message ? error.message : error)
      }
    };
  }
}

function printOut(out) {
  if (!out) return;
  if (out.stdout) {
    process.stdout.write(out.stdout);
  } else if (out.payload) {
    process.stdout.write(`${JSON.stringify(out.payload, null, 2)}\n`);
  }
  if (out.stderr) process.stderr.write(String(out.stderr));
}

if (require.main === module) {
  const out = runCore(process.argv.slice(2));
  printOut(out);
  process.exit(Number.isFinite(Number(out && out.status)) ? Number(out.status) : 1);
}

module.exports = {
  lane: bridge.lane,
  run: (args = []) => runCore(args)
};
