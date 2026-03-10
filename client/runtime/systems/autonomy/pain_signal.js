#!/usr/bin/env node
'use strict';

// Layer ownership: core/layer2/autonomy + core/layer0/ops::autonomy-controller (authoritative)
// Thin wrapper only; pain-signal authority lives in Rust.
const { createOpsLaneBridge } = require('../../lib/rust_lane_bridge');

process.env.PROTHEUS_CONDUIT_STARTUP_PROBE = '0';
process.env.PROTHEUS_CONDUIT_COMPAT_FALLBACK = '0';
process.env.PROTHEUS_OPS_DOMAIN_BRIDGE_TIMEOUT_MS =
  process.env.PROTHEUS_OPS_DOMAIN_BRIDGE_TIMEOUT_MS || '15000';
process.env.PROTHEUS_OPS_LOCAL_TIMEOUT_MS =
  process.env.PROTHEUS_OPS_LOCAL_TIMEOUT_MS || '20000';

const bridge = createOpsLaneBridge(__dirname, 'autonomy_controller', 'autonomy-controller');

function runCore(args = []) {
  const out = bridge.run(['pain-signal', ...(Array.isArray(args) ? args : [])]);
  if (out && out.stdout) process.stdout.write(out.stdout);
  if (out && out.stderr) process.stderr.write(out.stderr);
  if (out && out.payload && !out.stdout) process.stdout.write(`${JSON.stringify(out.payload)}\n`);
  return out;
}

function cleanText(v, max = 260) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
}

function emitPainSignal(input = {}) {
  const args = ['--action=emit'];
  const map = {
    source: 120,
    subsystem: 120,
    code: 120,
    summary: 800,
    details: 4000,
    severity: 24,
    risk: 24,
    window_hours: 24,
    escalate_after: 24,
    cooldown_hours: 24,
    create_proposal: 8
  };
  for (const [key, max] of Object.entries(map)) {
    if (Object.prototype.hasOwnProperty.call(input, key) && input[key] != null) {
      args.push(`--${key}=${cleanText(input[key], max)}`);
    }
  }
  const out = bridge.run(['pain-signal', ...args]);
  return (out && out.payload) || {
    ok: false,
    type: 'pain_signal_bridge_error',
    error: 'pain_signal_core_unavailable'
  };
}

function status() {
  const out = bridge.run(['pain-signal', '--action=status']);
  return (out && out.payload) || {
    ok: false,
    type: 'pain_signal_bridge_error',
    error: 'pain_signal_core_unavailable'
  };
}

function startPainFocusSession(input = {}) {
  const args = ['--action=focus-start'];
  if (input.task != null) args.push(`--task=${cleanText(input.task, 260)}`);
  if (input.ttl_minutes != null) args.push(`--ttl_minutes=${cleanText(input.ttl_minutes, 16)}`);
  if (input.source != null) args.push(`--source=${cleanText(input.source, 120)}`);
  if (input.reason != null) args.push(`--reason=${cleanText(input.reason, 260)}`);
  const out = bridge.run(['pain-signal', ...args]);
  return (out && out.payload) || {
    ok: false,
    type: 'pain_signal_bridge_error',
    error: 'pain_signal_core_unavailable'
  };
}

function stopPainFocusSession(input = {}) {
  const args = ['--action=focus-stop'];
  if (input.session_id != null) args.push(`--session_id=${cleanText(input.session_id, 160)}`);
  if (input.reason != null) args.push(`--reason=${cleanText(input.reason, 260)}`);
  const out = bridge.run(['pain-signal', ...args]);
  return (out && out.payload) || {
    ok: false,
    type: 'pain_signal_bridge_error',
    error: 'pain_signal_core_unavailable'
  };
}

function getPainFocusStatus() {
  const out = bridge.run(['pain-signal', '--action=focus-status']);
  return (out && out.payload) || {
    ok: false,
    type: 'pain_signal_bridge_error',
    error: 'pain_signal_core_unavailable'
  };
}

if (require.main === module) {
  const raw = process.argv.slice(2);
  const cmd = String(raw[0] || 'status').trim().toLowerCase();
  const args = raw.slice(1);
  const action = cmd === 'emit' || cmd === 'status' || cmd === 'focus-start' || cmd === 'focus-stop' || cmd === 'focus-status'
    ? cmd
    : 'status';
  const out = runCore([`--action=${action}`, ...args]);
  process.exit(Number.isFinite(out && out.status) ? Number(out.status) : 1);
}

module.exports = {
  lane: bridge.lane,
  run: (args = []) => bridge.run(['pain-signal', ...(Array.isArray(args) ? args : [])]),
  emitPainSignal,
  status,
  startPainFocusSession,
  stopPainFocusSession,
  getPainFocusStatus
};
