#!/usr/bin/env node
'use strict';
export {};

// Layer ownership: client/runtime/lib (thin bridge over core/layer0/ops llamaindex-bridge)

const { createOpsLaneBridge } = require('./rust_lane_bridge.ts');

process.env.PROTHEUS_OPS_USE_PREBUILT = process.env.PROTHEUS_OPS_USE_PREBUILT || '0';
process.env.PROTHEUS_OPS_LOCAL_TIMEOUT_MS = process.env.PROTHEUS_OPS_LOCAL_TIMEOUT_MS || '120000';
const bridge = createOpsLaneBridge(__dirname, 'llamaindex_bridge', 'llamaindex-bridge', {
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
  const out = bridge.run(args);
  const receipt = out && out.payload && typeof out.payload === 'object' ? out.payload : null;
  const payloadOut = receipt && receipt.payload && typeof receipt.payload === 'object' ? receipt.payload : receipt;
  if (out.status !== 0) {
    const message = payloadOut && typeof payloadOut.error === 'string'
      ? payloadOut.error
      : (out && out.stderr ? String(out.stderr).trim() : `llamaindex_bridge_${command}_failed`);
    if (opts.throwOnError !== false) throw new Error(message || `llamaindex_bridge_${command}_failed`);
    return { ok: false, error: message || `llamaindex_bridge_${command}_failed` };
  }
  if (!payloadOut || typeof payloadOut !== 'object') {
    const message = out && out.stderr
      ? String(out.stderr).trim() || `llamaindex_bridge_${command}_bridge_failed`
      : `llamaindex_bridge_${command}_bridge_failed`;
    if (opts.throwOnError !== false) throw new Error(message);
    return { ok: false, error: message };
  }
  return payloadOut;
}

const status = (opts = {}) => invoke('status', opts);
const registerIndex = (payload) => invoke('register-index', payload);
const query = (payload) => invoke('query', payload);
const runAgentWorkflow = (payload) => invoke('run-agent-workflow', payload);
const ingestMultimodal = (payload) => invoke('ingest-multimodal', payload);
const recordMemoryEval = (payload) => invoke('record-memory-eval', payload);
const runConditionalWorkflow = (payload) => invoke('run-conditional-workflow', payload);
const emitTrace = (payload) => invoke('emit-trace', payload);
const registerConnector = (payload) => invoke('register-connector', payload);
const connectorQuery = (payload) => invoke('connector-query', payload);

module.exports = {
  status,
  registerIndex,
  query,
  runAgentWorkflow,
  ingestMultimodal,
  recordMemoryEval,
  runConditionalWorkflow,
  emitTrace,
  registerConnector,
  connectorQuery,
};
