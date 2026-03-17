#!/usr/bin/env node
'use strict';
export {};

// Layer ownership: core/layer0/ops (authoritative)
// Thin TypeScript wrapper only. Console emission remains local presentation logic.

const path = require('path');
const { CANONICAL_PATHS } = require('./runtime_path_registry.ts');
const { createOpsLaneBridge } = require('./rust_lane_bridge.ts');

const DEFAULT_POLICY_REL = path.join('client', 'runtime', 'config', 'mech_suit_mode_policy.json');

function repoRoot(rootOverride = null) {
  if (rootOverride) return path.resolve(String(rootOverride));
  return path.resolve(__dirname, '..', '..', '..');
}

function text(value, maxLen = 240) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeRelPath(value, fallback) {
  const raw = text(value, 400);
  return raw || fallback;
}

function resolvePolicyPath(rootOverride = null) {
  const root = repoRoot(rootOverride);
  const explicit = text(process.env.MECH_SUIT_MODE_POLICY_PATH, 400);
  if (!explicit) return path.join(root, DEFAULT_POLICY_REL);
  return path.resolve(explicit);
}

function resolveStatePath(policy, relPath) {
  const root = policy && policy._root ? String(policy._root) : repoRoot();
  const requested = String(relPath || '').trim();
  if (!requested) return root;
  if (path.isAbsolute(requested)) return requested;
  const canonicalRel = String(requested)
    .replace(/\\/g, '/')
    .replace(/^state(\/|$)/, `${CANONICAL_PATHS.client_state_root}/`)
    .replace(/^local(\/|$)/, `${CANONICAL_PATHS.client_local_root}/`);
  const normalized = path.basename(root).toLowerCase() === 'client'
    ? canonicalRel.replace(/^client\//, '')
    : canonicalRel;
  return path.join(root, normalized);
}

process.env.PROTHEUS_OPS_USE_PREBUILT = process.env.PROTHEUS_OPS_USE_PREBUILT || '0';
process.env.PROTHEUS_OPS_LOCAL_TIMEOUT_MS = process.env.PROTHEUS_OPS_LOCAL_TIMEOUT_MS || '120000';
const bridge = createOpsLaneBridge(__dirname, 'mech_suit_mode', 'mech-suit-mode-kernel');

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
      : (out && out.stderr ? String(out.stderr).trim() : `mech_suit_mode_kernel_${command}_failed`);
    if (opts.throwOnError !== false) throw new Error(message || `mech_suit_mode_kernel_${command}_failed`);
    return { ok: false, error: message || `mech_suit_mode_kernel_${command}_failed` };
  }
  if (!payloadOut || typeof payloadOut !== 'object') {
    const message = out && out.stderr
      ? String(out.stderr).trim() || `mech_suit_mode_kernel_${command}_bridge_failed`
      : `mech_suit_mode_kernel_${command}_bridge_failed`;
    if (opts.throwOnError !== false) throw new Error(message);
    return { ok: false, error: message };
  }
  return payloadOut;
}

function loadMechSuitModePolicy(opts = {}) {
  const root = repoRoot(opts.root);
  const policyPath = resolvePolicyPath(root);
  const out = invoke('load-policy', {
    root,
    policy_path: policyPath
  });
  return out.policy || {};
}

function approxTokenCount(value) {
  const out = invoke('approx-token-count', { value });
  return Number(out.token_count || 0);
}

function classifySeverity(message, patterns = []) {
  const out = invoke('classify-severity', {
    message,
    patterns: Array.isArray(patterns) ? patterns : []
  });
  return String(out.severity || 'info');
}

function shouldEmitAmbientConsole(message, method, policy) {
  const out = invoke('should-emit-console', {
    message,
    method,
    policy: policy && typeof policy === 'object' ? policy : undefined,
    policy_path: resolvePolicyPath(policy && policy._root ? policy._root : null)
  });
  return out.emit === true;
}

function emitAmbientConsole(message, method, policy) {
  if (!shouldEmitAmbientConsole(message, method, policy)) return false;
  const line = String(message == null ? '' : message);
  if (!line) return false;
  const target = method === 'error' ? process.stderr : process.stdout;
  target.write(line.endsWith('\n') ? line : `${line}\n`);
  return true;
}

function updateMechSuitStatus(component, patch, opts = {}) {
  const root = repoRoot(opts.root);
  const policy = opts.policy || loadMechSuitModePolicy({ root });
  const out = invoke('update-status', {
    component,
    patch: patch && typeof patch === 'object' ? patch : {},
    policy,
    root,
    policy_path: resolvePolicyPath(root)
  });
  return out.status || null;
}

async function appendAttentionQueueEvent(event, opts = {}) {
  const root = repoRoot(opts.root);
  const policy = opts.policy || loadMechSuitModePolicy({ root });
  const out = invoke('append-attention-event', {
    event: event && typeof event === 'object' ? event : {},
    run_context: text(opts.runContext, 40) || 'eyes',
    policy,
    root,
    policy_path: resolvePolicyPath(root)
  });
  return {
    ok: out.ok !== false,
    queued: out.queued === true,
    event: out.event || null,
    decision: out.decision || null,
    routed_via: out.routed_via || 'rust_kernel'
  };
}

module.exports = {
  approxTokenCount,
  appendAttentionQueueEvent,
  classifySeverity,
  emitAmbientConsole,
  loadMechSuitModePolicy,
  normalizeRelPath,
  repoRoot,
  resolvePolicyPath,
  resolveStatePath,
  shouldEmitAmbientConsole,
  text,
  updateMechSuitStatus
};
