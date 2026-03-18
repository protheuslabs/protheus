#!/usr/bin/env node
'use strict';
export {};

const { createOpsLaneBridge } = require('./rust_lane_bridge.ts');

process.env.PROTHEUS_OPS_USE_PREBUILT = process.env.PROTHEUS_OPS_USE_PREBUILT || '0';
process.env.PROTHEUS_OPS_LOCAL_TIMEOUT_MS = process.env.PROTHEUS_OPS_LOCAL_TIMEOUT_MS || '120000';
const bridge = createOpsLaneBridge(__dirname, 'shannon_bridge', 'shannon-bridge', {
  preferLocalCore: true
});

function encodeBase64(value) {
  return Buffer.from(String(value == null ? '' : value), 'utf8').toString('base64');
}

function invoke(command, payload = {}, opts = {}) {
  const args = [command, `--payload-base64=${encodeBase64(JSON.stringify(payload || {}))}`];
  if (payload && payload.state_path) args.push(`--state-path=${String(payload.state_path)}`);
  if (payload && payload.history_path) args.push(`--history-path=${String(payload.history_path)}`);
  if (payload && payload.approval_queue_path) args.push(`--approval-queue-path=${String(payload.approval_queue_path)}`);
  if (payload && payload.replay_dir) args.push(`--replay-dir=${String(payload.replay_dir)}`);
  if (payload && payload.observability_trace_path) args.push(`--observability-trace-path=${String(payload.observability_trace_path)}`);
  if (payload && payload.observability_metrics_path) args.push(`--observability-metrics-path=${String(payload.observability_metrics_path)}`);
  if (payload && payload.desktop_history_path) args.push(`--desktop-history-path=${String(payload.desktop_history_path)}`);
  const out = bridge.run(args);
  const receipt = out && out.payload && typeof out.payload === 'object' ? out.payload : null;
  const payloadOut = receipt && receipt.payload && typeof receipt.payload === 'object' ? receipt.payload : receipt;
  if (out.status !== 0) {
    const message = payloadOut && typeof payloadOut.error === 'string'
      ? payloadOut.error
      : (out && out.stderr ? String(out.stderr).trim() : `shannon_bridge_${command}_failed`);
    if (opts.throwOnError !== false) throw new Error(message || `shannon_bridge_${command}_failed`);
    return { ok: false, error: message || `shannon_bridge_${command}_failed` };
  }
  if (!payloadOut || typeof payloadOut !== 'object') {
    const message = out && out.stderr
      ? String(out.stderr).trim() || `shannon_bridge_${command}_bridge_failed`
      : `shannon_bridge_${command}_bridge_failed`;
    if (opts.throwOnError !== false) throw new Error(message);
    return { ok: false, error: message };
  }
  return payloadOut;
}

const status = (opts = {}) => invoke('status', opts);
const registerPattern = (payload) => invoke('register-pattern', payload);
const guardBudget = (payload) => invoke('guard-budget', payload);
const memoryBridge = (payload) => invoke('memory-bridge', payload);
const replayRun = (payload) => invoke('replay-run', payload);
const approvalCheckpoint = (payload) => invoke('approval-checkpoint', payload);
const sandboxExecute = (payload) => invoke('sandbox-execute', payload);
const recordObservability = (payload) => invoke('record-observability', payload);
const gatewayRoute = (payload) => invoke('gateway-route', payload);
const registerTooling = (payload) => invoke('register-tooling', payload);
const scheduleRun = (payload) => invoke('schedule-run', payload);
const desktopShell = (payload) => invoke('desktop-shell', payload);
const p2pReliability = (payload) => invoke('p2p-reliability', payload);
const assimilateIntake = (payload) => invoke('assimilate-intake', payload);

module.exports = {
  status,
  registerPattern,
  guardBudget,
  memoryBridge,
  replayRun,
  approvalCheckpoint,
  sandboxExecute,
  recordObservability,
  gatewayRoute,
  registerTooling,
  scheduleRun,
  desktopShell,
  p2pReliability,
  assimilateIntake,
};
