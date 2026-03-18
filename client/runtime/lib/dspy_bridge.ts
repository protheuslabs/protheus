#!/usr/bin/env node
'use strict';
export {};

// Layer ownership: client/runtime/lib (thin bridge over core/layer0/ops dspy-bridge)

const { createOpsLaneBridge } = require('./rust_lane_bridge.ts');

process.env.PROTHEUS_OPS_USE_PREBUILT = process.env.PROTHEUS_OPS_USE_PREBUILT || '0';
process.env.PROTHEUS_OPS_LOCAL_TIMEOUT_MS = process.env.PROTHEUS_OPS_LOCAL_TIMEOUT_MS || '120000';
const bridge = createOpsLaneBridge(__dirname, 'dspy_bridge', 'dspy-bridge', {
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
      : (out && out.stderr ? String(out.stderr).trim() : `dspy_bridge_${command}_failed`);
    if (opts.throwOnError !== false) throw new Error(message || `dspy_bridge_${command}_failed`);
    return { ok: false, error: message || `dspy_bridge_${command}_failed` };
  }
  if (!payloadOut || typeof payloadOut !== 'object') {
    const message = out && out.stderr
      ? String(out.stderr).trim() || `dspy_bridge_${command}_bridge_failed`
      : `dspy_bridge_${command}_bridge_failed`;
    if (opts.throwOnError !== false) throw new Error(message);
    return { ok: false, error: message };
  }
  return payloadOut;
}

const status = (opts = {}) => invoke('status', opts);
const registerSignature = (payload) => invoke('register-signature', payload);
const compileProgram = (payload) => invoke('compile-program', payload);
const optimizeProgram = (payload) => invoke('optimize-program', payload);
const assertProgram = (payload) => invoke('assert-program', payload);
const importIntegration = (payload) => invoke('import-integration', payload);
const executeMultihop = (payload) => invoke('execute-multihop', payload);
const recordBenchmark = (payload) => invoke('record-benchmark', payload);
const recordOptimizationTrace = (payload) => invoke('record-optimization-trace', payload);
const assimilateIntake = (payload) => invoke('assimilate-intake', payload);

module.exports = {
  status,
  registerSignature,
  compileProgram,
  optimizeProgram,
  assertProgram,
  importIntegration,
  executeMultihop,
  recordBenchmark,
  recordOptimizationTrace,
  assimilateIntake,
};
