#!/usr/bin/env node
'use strict';

// Layer ownership: core/layer0/ops (authoritative)
// Thin TypeScript wrapper only.

const path = require('path');
const { createOpsLaneBridge } = require('../../lib/rust_lane_bridge.ts');

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;
const DEFAULT_STATE_PATH = path.resolve(
  __dirname,
  '..',
  '..',
  'local',
  'state',
  'memory',
  'session_isolation.json'
);

process.env.PROTHEUS_OPS_USE_PREBUILT = process.env.PROTHEUS_OPS_USE_PREBUILT || '0';
process.env.PROTHEUS_OPS_LOCAL_TIMEOUT_MS = process.env.PROTHEUS_OPS_LOCAL_TIMEOUT_MS || '120000';
const bridge = createOpsLaneBridge(__dirname, 'session_isolation', 'memory-session-isolation-kernel');

function encodeBase64(value) {
  return Buffer.from(String(value == null ? '' : value), 'utf8').toString('base64');
}

function invoke(command, payload = {}, opts = {}) {
  const out = bridge.run([
    command,
    `--payload-base64=${encodeBase64(JSON.stringify(payload || {}))}`
  ]);
  const receipt = out && out.payload && typeof out.payload === 'object' ? out.payload : null;
  const payloadOut = receipt && receipt.payload && typeof receipt.payload === 'object'
    ? receipt.payload
    : receipt;
  if (out.status !== 0) {
    const message = payloadOut && typeof payloadOut.error === 'string'
      ? payloadOut.error
      : (out && out.stderr ? String(out.stderr).trim() : `memory_session_isolation_kernel_${command}_failed`);
    if (opts.throwOnError !== false) throw new Error(message || `memory_session_isolation_kernel_${command}_failed`);
    return { ok: false, error: message || `memory_session_isolation_kernel_${command}_failed` };
  }
  if (!payloadOut || typeof payloadOut !== 'object') {
    const message = out && out.stderr
      ? String(out.stderr).trim() || `memory_session_isolation_kernel_${command}_bridge_failed`
      : `memory_session_isolation_kernel_${command}_bridge_failed`;
    if (opts.throwOnError !== false) throw new Error(message);
    return { ok: false, error: message };
  }
  return payloadOut;
}

function loadState(filePath = DEFAULT_STATE_PATH) {
  const out = invoke('load-state', { state_path: filePath });
  return out.state && typeof out.state === 'object'
    ? out.state
    : {
        schema_version: '1.0',
        resources: {}
      };
}

function saveState(state, filePath = DEFAULT_STATE_PATH) {
  const out = invoke('save-state', {
    state: state && typeof state === 'object' ? state : {},
    state_path: filePath
  });
  return out.state && typeof out.state === 'object'
    ? out.state
    : {
        schema_version: '1.0',
        resources: {}
      };
}

function validateSessionIsolation(args = [], options = {}) {
  const out = invoke('validate', {
    args: Array.isArray(args) ? args : [],
    options: options && typeof options === 'object' ? options : {}
  });
  return out.validation && typeof out.validation === 'object'
    ? out.validation
    : {
        ok: false,
        type: 'memory_session_isolation',
        reason_code: 'session_isolation_validation_failed'
      };
}

function sessionFailureResult(validation, context = {}) {
  const out = invoke('failure-result', {
    validation: validation && typeof validation === 'object' ? validation : {},
    context: context && typeof context === 'object' ? context : {}
  });
  return out.result && typeof out.result === 'object'
    ? out.result
    : {
        ok: false,
        status: 2,
        stdout: `${JSON.stringify({
          ok: false,
          type: 'memory_session_isolation_reject',
          reason: 'session_isolation_failed',
          fail_closed: true
        })}\n`,
        stderr: 'memory_session_isolation_reject:session_isolation_failed\n',
        payload: {
          ok: false,
          type: 'memory_session_isolation_reject',
          reason: 'session_isolation_failed',
          fail_closed: true
        }
      };
}

module.exports = {
  SESSION_ID_PATTERN,
  DEFAULT_STATE_PATH,
  loadState,
  saveState,
  validateSessionIsolation,
  sessionFailureResult
};
