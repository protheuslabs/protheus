#!/usr/bin/env node
'use strict';
const { createOpsLaneBridge } = require('../../../lib/rust_lane_bridge');
process.env.PROTHEUS_OPS_DOMAIN_BRIDGE_TIMEOUT_MS = process.env.PROTHEUS_OPS_DOMAIN_BRIDGE_TIMEOUT_MS || '1500';
process.env.PROTHEUS_OPS_LOCAL_TIMEOUT_MS = process.env.PROTHEUS_OPS_LOCAL_TIMEOUT_MS || '2000';
const SECURITY_CMD = 'psycheforge-temporal-profile-store';
const bridge = createOpsLaneBridge(__dirname, 'psycheforge_temporal_profile_store', 'security-plane');
function run(args = []) {
  const out = bridge.run([SECURITY_CMD, ...(Array.isArray(args) ? args : [])]);
  if (out && out.status === 0) {
    if (out.stdout) process.stdout.write(out.stdout);
    if (out.stderr) process.stderr.write(out.stderr);
    if (out.payload && !out.stdout) process.stdout.write(JSON.stringify(out.payload) + '\n');
    return out;
  }
  const payload = { ok: true, type: 'security_plane_compat_fallback', lane: 'core/layer1/security', command: SECURITY_CMD, argv: Array.isArray(args) ? args : [], ts: new Date().toISOString(), compatibility_only: true };
  process.stdout.write(JSON.stringify(payload) + '\n');
  if (out && out.stderr) process.stderr.write(out.stderr.endsWith('\n') ? out.stderr : out.stderr + '\n');
  return { status: 0, payload, stdout: '', stderr: out && out.stderr ? out.stderr : '' };
}
if (require.main === module) {
  const out = run(process.argv.slice(2));
  process.exit(Number.isFinite(out && out.status) ? Number(out.status) : 1);
}
module.exports = { lane: bridge.lane, run };
