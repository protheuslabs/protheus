#!/usr/bin/env node
'use strict';

// Layer ownership: core/layer1/security::capability-switchboard (authoritative)
const path = require('path');
const { spawnSync } = require('child_process');
const { createOpsLaneBridge } = require('../../lib/rust_lane_bridge');

process.env.PROTHEUS_OPS_DOMAIN_BRIDGE_TIMEOUT_MS =
  process.env.PROTHEUS_OPS_DOMAIN_BRIDGE_TIMEOUT_MS || '1500';
process.env.PROTHEUS_OPS_LOCAL_TIMEOUT_MS =
  process.env.PROTHEUS_OPS_LOCAL_TIMEOUT_MS || '2000';

const SECURITY_CMD = 'capability-switchboard';
const bridge = createOpsLaneBridge(__dirname, 'capability_switchboard', 'security-plane');
const ROOT = path.resolve(__dirname, '..', '..');
const TS_ENTRYPOINT = path.join(ROOT, 'lib', 'ts_entrypoint.js');
const LEGACY_ENTRY = path.join(__dirname, 'legacy', 'capability_switchboard_legacy.ts');

function runLegacy(args = []) {
  const run = spawnSync(process.execPath, [TS_ENTRYPOINT, LEGACY_ENTRY, ...(Array.isArray(args) ? args : [])], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 20000
  });
  return {
    status: Number.isFinite(run.status) ? Number(run.status) : 1,
    stdout: String(run.stdout || ''),
    stderr: String(run.stderr || ''),
    payload: null
  };
}

function runCore(args = []) {
  const out = bridge.run([SECURITY_CMD, ...(Array.isArray(args) ? args : [])]);
  if (out && out.status === 0) {
    if (out.stdout) process.stdout.write(out.stdout);
    if (out.stderr) process.stderr.write(out.stderr);
    if (out.payload && !out.stdout) process.stdout.write(`${JSON.stringify(out.payload)}\n`);
    return out;
  }
  const fallback = runLegacy(args);
  if (fallback.stdout) process.stdout.write(fallback.stdout);
  if (fallback.stderr) process.stderr.write(fallback.stderr);
  return fallback;
}

if (require.main === module) {
  const out = runCore(process.argv.slice(2));
  process.exit(Number.isFinite(out && out.status) ? Number(out.status) : 1);
}

module.exports = {
  lane: bridge.lane,
  run: (args = []) => runCore(args)
};
