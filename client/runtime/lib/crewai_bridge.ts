#!/usr/bin/env node
'use strict';
export {};

// Layer ownership: client/runtime/lib (thin bridge over core/layer0/ops crewai-bridge)

const { createOpsLaneBridge } = require('./rust_lane_bridge.ts');

process.env.PROTHEUS_OPS_USE_PREBUILT = process.env.PROTHEUS_OPS_USE_PREBUILT || '0';
process.env.PROTHEUS_OPS_LOCAL_TIMEOUT_MS = process.env.PROTHEUS_OPS_LOCAL_TIMEOUT_MS || '120000';
const bridge = createOpsLaneBridge(__dirname, 'crewai_bridge', 'crewai-bridge', {
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
  if (payload && payload.trace_path) args.push(`--trace-path=${String(payload.trace_path)}`);
  const out = bridge.run(args);
  const receipt = out && out.payload && typeof out.payload === 'object' ? out.payload : null;
  const payloadOut = receipt && receipt.payload && typeof receipt.payload === 'object' ? receipt.payload : receipt;
  if (out.status !== 0) {
    const message = payloadOut && typeof payloadOut.error === 'string'
      ? payloadOut.error
      : (out && out.stderr ? String(out.stderr).trim() : `crewai_bridge_${command}_failed`);
    if (opts.throwOnError !== false) throw new Error(message || `crewai_bridge_${command}_failed`);
    return { ok: false, error: message || `crewai_bridge_${command}_failed` };
  }
  if (!payloadOut || typeof payloadOut !== 'object') {
    const message = out && out.stderr
      ? String(out.stderr).trim() || `crewai_bridge_${command}_bridge_failed`
      : `crewai_bridge_${command}_bridge_failed`;
    if (opts.throwOnError !== false) throw new Error(message);
    return { ok: false, error: message };
  }
  return payloadOut;
}

const status = (opts = {}) => invoke('status', opts);
const registerCrew = (payload) => invoke('register-crew', payload);
const runProcess = (payload) => invoke('run-process', payload);
const runFlow = (payload) => invoke('run-flow', payload);
const memoryBridge = (payload) => invoke('memory-bridge', payload);
const ingestConfig = (payload) => invoke('ingest-config', payload);
const routeDelegation = (payload) => invoke('route-delegation', payload);
const reviewCrew = (payload) => invoke('review-crew', payload);
const recordAmpTrace = (payload) => invoke('record-amp-trace', payload);
const benchmarkParity = (payload) => invoke('benchmark-parity', payload);
const routeModel = (payload) => invoke('route-model', payload);

module.exports = {
  status,
  registerCrew,
  runProcess,
  runFlow,
  memoryBridge,
  ingestConfig,
  routeDelegation,
  reviewCrew,
  recordAmpTrace,
  benchmarkParity,
  routeModel,
};
