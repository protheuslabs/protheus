#!/usr/bin/env node
'use strict';
export {};

// Layer ownership: client/runtime/lib (thin bridge over core/layer0/ops dify-bridge)

const { createOpsLaneBridge } = require('./rust_lane_bridge.ts');

process.env.PROTHEUS_OPS_USE_PREBUILT = process.env.PROTHEUS_OPS_USE_PREBUILT || '0';
process.env.PROTHEUS_OPS_LOCAL_TIMEOUT_MS = process.env.PROTHEUS_OPS_LOCAL_TIMEOUT_MS || '120000';
const bridge = createOpsLaneBridge(__dirname, 'dify_bridge', 'dify-bridge', {
  preferLocalCore: true
});

function encodeBase64(value) {
  return Buffer.from(String(value == null ? '' : value), 'utf8').toString('base64');
}

function invoke(command, payload = {}, opts = {}) {
  const args = [command, `--payload-base64=${encodeBase64(JSON.stringify(payload || {}))}`];
  if (payload && payload.state_path) args.push(`--state-path=${String(payload.state_path)}`);
  if (payload && payload.history_path) args.push(`--history-path=${String(payload.history_path)}`);
  if (payload && payload.swarm_state_path) args.push(`--swarm-state-path=${String(payload.swarm_state_path)}`);
  if (payload && payload.trace_path) args.push(`--trace-path=${String(payload.trace_path)}`);
  if (payload && payload.dashboard_dir) args.push(`--dashboard-dir=${String(payload.dashboard_dir)}`);
  const out = bridge.run(args);
  const receipt = out && out.payload && typeof out.payload === 'object' ? out.payload : null;
  const payloadOut = receipt && receipt.payload && typeof receipt.payload === 'object' ? receipt.payload : receipt;
  if (out.status !== 0) {
    const message = payloadOut && typeof payloadOut.error === 'string'
      ? payloadOut.error
      : (out && out.stderr ? String(out.stderr).trim() : `dify_bridge_${command}_failed`);
    if (opts.throwOnError !== false) throw new Error(message || `dify_bridge_${command}_failed`);
    return { ok: false, error: message || `dify_bridge_${command}_failed` };
  }
  if (!payloadOut || typeof payloadOut !== 'object') {
    const message = out && out.stderr
      ? String(out.stderr).trim() || `dify_bridge_${command}_bridge_failed`
      : `dify_bridge_${command}_bridge_failed`;
    if (opts.throwOnError !== false) throw new Error(message);
    return { ok: false, error: message };
  }
  return payloadOut;
}

const status = (opts = {}) => invoke('status', opts);
const registerCanvas = (payload) => invoke('register-canvas', payload);
const syncKnowledgeBase = (payload) => invoke('sync-knowledge-base', payload);
const registerAgentApp = (payload) => invoke('register-agent-app', payload);
const publishDashboard = (payload) => invoke('publish-dashboard', payload);
const routeProvider = (payload) => invoke('route-provider', payload);
const runConditionalFlow = (payload) => invoke('run-conditional-flow', payload);
const recordAuditTrace = (payload) => invoke('record-audit-trace', payload);

module.exports = {
  status,
  registerCanvas,
  syncKnowledgeBase,
  registerAgentApp,
  publishDashboard,
  routeProvider,
  runConditionalFlow,
  recordAuditTrace,
};
