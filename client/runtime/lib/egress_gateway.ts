#!/usr/bin/env node
'use strict';
export {};

// Layer ownership: core/layer0/ops (authoritative)
// Thin TypeScript wrapper only. Network fetch remains local presentation logic.

const path = require('path');
const { createOpsLaneBridge } = require('./rust_lane_bridge.ts');

const DEFAULT_POLICY_REL = 'config/egress_gateway_policy.json';
const DEFAULT_STATE_REL = 'local/state/security/egress_gateway/state.json';
const DEFAULT_AUDIT_REL = 'local/state/security/egress_gateway/audit.jsonl';

function runtimeRoot() {
  if (process.env.PROTHEUS_RUNTIME_ROOT) {
    return path.resolve(String(process.env.PROTHEUS_RUNTIME_ROOT));
  }
  return path.resolve(__dirname, '..');
}

function cleanText(v, maxLen = 260) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeToken(v, maxLen = 120) {
  return cleanText(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.:/-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

const ROOT = runtimeRoot();

class EgressGatewayError extends Error {
  constructor(message, decision) {
    super(message);
    this.name = 'EgressGatewayError';
    this.decision = decision && typeof decision === 'object' ? decision : {};
    this.details = this.decision;
  }
}

function resolvePath(raw, fallbackRel) {
  const value = cleanText(raw, 520);
  if (!value) return path.join(ROOT, fallbackRel);
  return path.isAbsolute(value) ? value : path.join(ROOT, value);
}

function policyPath() {
  return resolvePath(process.env.EGRESS_GATEWAY_POLICY_PATH, DEFAULT_POLICY_REL);
}

function statePath() {
  return resolvePath(process.env.EGRESS_GATEWAY_STATE_PATH, DEFAULT_STATE_REL);
}

function auditPath() {
  return resolvePath(process.env.EGRESS_GATEWAY_AUDIT_PATH, DEFAULT_AUDIT_REL);
}

process.env.PROTHEUS_OPS_USE_PREBUILT = process.env.PROTHEUS_OPS_USE_PREBUILT || '0';
process.env.PROTHEUS_OPS_LOCAL_TIMEOUT_MS = process.env.PROTHEUS_OPS_LOCAL_TIMEOUT_MS || '120000';
const bridge = createOpsLaneBridge(__dirname, 'egress_gateway', 'egress-gateway-kernel');

function encodeBase64(value) {
  return Buffer.from(String(value == null ? '' : value), 'utf8').toString('base64');
}

function normalizeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
}

function invoke(command, payload = {}, opts = {}) {
  const out = bridge.run([
    command,
    `--payload-base64=${encodeBase64(JSON.stringify(normalizeObject(payload)))}`
  ]);
  const receipt = out && out.payload && typeof out.payload === 'object' ? out.payload : null;
  const payloadOut = receipt && receipt.payload && typeof receipt.payload === 'object'
    ? receipt.payload
    : receipt;
  if (out.status !== 0) {
    const message = payloadOut && typeof payloadOut.error === 'string'
      ? payloadOut.error
      : (out && out.stderr ? String(out.stderr).trim() : `egress_gateway_kernel_${command}_failed`);
    if (opts.throwOnError !== false) throw new Error(message || `egress_gateway_kernel_${command}_failed`);
    return { ok: false, error: message || `egress_gateway_kernel_${command}_failed` };
  }
  if (!payloadOut || typeof payloadOut !== 'object') {
    const message = out && out.stderr
      ? String(out.stderr).trim() || `egress_gateway_kernel_${command}_bridge_failed`
      : `egress_gateway_kernel_${command}_bridge_failed`;
    if (opts.throwOnError !== false) throw new Error(message);
    return { ok: false, error: message };
  }
  return payloadOut;
}

function loadPolicy() {
  const out = invoke('load-policy', {
    root: ROOT,
    policy_path: policyPath()
  });
  return out.policy || {};
}

function loadState() {
  const out = invoke('load-state', {
    root: ROOT,
    state_path: statePath()
  });
  return out.state || {};
}

function authorizeEgress(input = {}) {
  return invoke('authorize', {
    root: ROOT,
    policy_path: policyPath(),
    state_path: statePath(),
    audit_path: auditPath(),
    scope: input.scope,
    caller: input.caller,
    runtime_allowlist: Array.isArray(input.runtime_allowlist) ? input.runtime_allowlist : [],
    now_ms: input.now_ms,
    apply: input.apply !== false,
    url: cleanText(input.url, 2000),
    method: normalizeToken(input.method || 'GET', 20).toUpperCase() || 'GET'
  });
}

async function egressFetch(url, init = {}, context = {}) {
  const method = normalizeToken(init.method || 'GET', 20).toUpperCase() || 'GET';
  const decision = authorizeEgress({
    scope: context.scope,
    caller: context.caller,
    runtime_allowlist: context.runtime_allowlist,
    now_ms: context.now_ms,
    apply: context.apply !== false,
    url,
    method
  });
  if (!decision.allow) {
    throw new EgressGatewayError(`egress_denied:${decision.reason || decision.code || 'policy'}`, decision);
  }
  const fetchImpl = globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('egress_fetch_unavailable');
  }
  const timeoutMs = Number(context.timeout_ms || context.timeoutMs || 0);
  if (!(timeoutMs > 0)) {
    return fetchImpl(url, init);
  }
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller
    ? setTimeout(() => controller.abort(new Error(`egress_fetch_timeout:${timeoutMs}`)), timeoutMs)
    : null;
  try {
    const nextInit = controller ? { ...init, signal: controller.signal } : init;
    return await fetchImpl(url, nextInit);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function egressFetchText(url, init = {}, context = {}) {
  const res = await egressFetch(url, init, context);
  const text = await res.text();
  return {
    status: Number(res.status || 0),
    ok: !!res.ok,
    text,
    headers: typeof res.headers?.entries === 'function'
      ? Object.fromEntries(Array.from(res.headers.entries()))
      : {},
    bytes: Buffer.byteLength(String(text || ''), 'utf8')
  };
}

module.exports = {
  EgressGatewayError,
  authorizeEgress,
  egressFetch,
  egressFetchText,
  loadPolicy,
  loadState
};
