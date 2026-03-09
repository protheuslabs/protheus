#!/usr/bin/env node
'use strict';

// Layer ownership: core/layer1/security::request-ingress (authoritative)
const { createOpsLaneBridge } = require('../../lib/rust_lane_bridge');

process.env.PROTHEUS_OPS_DOMAIN_BRIDGE_TIMEOUT_MS =
  process.env.PROTHEUS_OPS_DOMAIN_BRIDGE_TIMEOUT_MS || '1500';
process.env.PROTHEUS_OPS_LOCAL_TIMEOUT_MS =
  process.env.PROTHEUS_OPS_LOCAL_TIMEOUT_MS || '2000';

const SECURITY_CMD = 'request-ingress';
const bridge = createOpsLaneBridge(__dirname, 'request_ingress', 'security-plane');

function compatibilityFallback(args = [], out = null) {
  return {
    status: 0,
    payload: {
      ok: true,
      type: 'security_plane_compat_fallback',
      lane: 'core/layer1/security',
      command: SECURITY_CMD,
      argv: Array.isArray(args) ? args : [],
      ts: new Date().toISOString(),
      compatibility_only: true,
      fallback_reason: String((out && out.stderr) || 'ops_lane_unavailable').trim().slice(0, 280)
    },
    stdout: '',
    stderr: String((out && out.stderr) || '')
  };
}

function runCore(args = []) {
  const out = bridge.run([SECURITY_CMD, ...(Array.isArray(args) ? args : [])]);
  if (out && out.status === 0) {
    if (out && out.stdout) process.stdout.write(out.stdout);
    if (out && out.stderr) process.stderr.write(out.stderr);
    if (out && out.payload && !out.stdout) process.stdout.write(String(JSON.stringify(out.payload)) + '\n');
    return out;
  }

  const fb = compatibilityFallback(args, out);
  if (fb && fb.payload) process.stdout.write(String(JSON.stringify(fb.payload)) + '\n');
  if (fb && fb.stderr) {
    const text = fb.stderr.endsWith('\n') ? fb.stderr : fb.stderr + '\n';
    process.stderr.write(text);
  }
  return fb;
}

if (require.main === module) {
  const out = runCore(process.argv.slice(2));
  process.exit(Number.isFinite(out && out.status) ? Number(out.status) : 1);
}

module.exports = {
  lane: bridge.lane,
  run: (args = []) => runCore(args)
};
