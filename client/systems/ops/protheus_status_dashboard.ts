#!/usr/bin/env node
'use strict';

/**
 * Rust-authoritative status dashboard wrapper.
 * TS remains a thin CLI surface only.
 */

const { createOpsLaneBridge } = require('../../lib/rust_lane_bridge');
const bridge = createOpsLaneBridge(__dirname, 'protheus_status_dashboard', 'status');

function runRustStatusDashboard(args = []) {
  const out = bridge.run(['--dashboard', ...args]);
  const status = Number.isFinite(out && out.status) ? Number(out.status) : 1;
  return {
    ok: status === 0,
    status,
    stdout: out && out.stdout || '',
    stderr: out && out.stderr || '',
    payload: out && out.payload || null
  };
}

if (require.main === module) {
  const out = runRustStatusDashboard(process.argv.slice(2));
  if (out.stdout) process.stdout.write(out.stdout);
  if (out.stderr) process.stderr.write(out.stderr);
  process.exit(out.status);
}

module.exports = {
  runRustStatusDashboard
};
