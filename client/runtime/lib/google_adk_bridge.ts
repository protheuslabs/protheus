#!/usr/bin/env node
'use strict';
export {};

// Layer ownership: client/runtime/lib (thin bridge over core/layer0/ops google-adk-bridge)

const { createOpsLaneBridge } = require('./rust_lane_bridge.ts');

process.env.PROTHEUS_OPS_USE_PREBUILT = process.env.PROTHEUS_OPS_USE_PREBUILT || '0';
process.env.PROTHEUS_OPS_LOCAL_TIMEOUT_MS = process.env.PROTHEUS_OPS_LOCAL_TIMEOUT_MS || '120000';
const bridge = createOpsLaneBridge(__dirname, 'google_adk_bridge', 'google-adk-bridge', {
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
  if (payload && payload.approval_queue_path) args.push(`--approval-queue-path=${String(payload.approval_queue_path)}`);
  const out = bridge.run(args);
  const receipt = out && out.payload && typeof out.payload === 'object' ? out.payload : null;
  const payloadOut = receipt && receipt.payload && typeof receipt.payload === 'object' ? receipt.payload : receipt;
  if (out.status !== 0) {
    const message = payloadOut && typeof payloadOut.error === 'string'
      ? payloadOut.error
      : (out && out.stderr ? String(out.stderr).trim() : `google_adk_bridge_${command}_failed`);
    if (opts.throwOnError !== false) throw new Error(message || `google_adk_bridge_${command}_failed`);
    return { ok: false, error: message || `google_adk_bridge_${command}_failed` };
  }
  if (!payloadOut || typeof payloadOut !== 'object') {
    const message = out && out.stderr
      ? String(out.stderr).trim() || `google_adk_bridge_${command}_bridge_failed`
      : `google_adk_bridge_${command}_bridge_failed`;
    if (opts.throwOnError !== false) throw new Error(message);
    return { ok: false, error: message };
  }
  return payloadOut;
}

const status = (opts = {}) => invoke('status', opts);
const registerA2aAgent = (payload) => invoke('register-a2a-agent', payload);
const sendA2aMessage = (payload) => invoke('send-a2a-message', payload);
const runLlmAgent = (payload) => invoke('run-llm-agent', payload);
const registerToolManifest = (payload) => invoke('register-tool-manifest', payload);
const invokeToolManifest = (payload) => invoke('invoke-tool-manifest', payload);
const coordinateHierarchy = (payload) => invoke('coordinate-hierarchy', payload);
const approvalCheckpoint = (payload) => invoke('approval-checkpoint', payload);
const rewindSession = (payload) => invoke('rewind-session', payload);
const recordEvaluation = (payload) => invoke('record-evaluation', payload);
const sandboxExecute = (payload) => invoke('sandbox-execute', payload);
const deployShell = (payload) => invoke('deploy-shell', payload);
const registerRuntimeBridge = (payload) => invoke('register-runtime-bridge', payload);
const routeModel = (payload) => invoke('route-model', payload);

module.exports = {
  status,
  registerA2aAgent,
  sendA2aMessage,
  runLlmAgent,
  registerToolManifest,
  invokeToolManifest,
  coordinateHierarchy,
  approvalCheckpoint,
  rewindSession,
  recordEvaluation,
  sandboxExecute,
  deployShell,
  registerRuntimeBridge,
  routeModel,
};
