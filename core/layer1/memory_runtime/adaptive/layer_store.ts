// @ts-nocheck
// Layer ownership: core/layer0/ops (authoritative)
'use strict';

const path = require('path');
const { createOpsLaneBridge } = require('../../../../client/runtime/lib/rust_lane_bridge.ts');

function workspaceRoot() {
  return process.env.PROTHEUS_WORKSPACE_ROOT
    ? path.resolve(String(process.env.PROTHEUS_WORKSPACE_ROOT))
    : path.resolve(__dirname, '..', '..', '..', '..');
}

function runtimeRoot() {
  return process.env.PROTHEUS_RUNTIME_ROOT
    ? path.resolve(String(process.env.PROTHEUS_RUNTIME_ROOT))
    : path.join(workspaceRoot(), 'client', 'runtime');
}

const REPO_ROOT = runtimeRoot();
const ADAPTIVE_ROOT = path.join(REPO_ROOT, 'adaptive');
const ADAPTIVE_RUNTIME_ROOT = path.join(REPO_ROOT, 'local', 'adaptive');
const MUTATION_LOG_PATH = path.join(REPO_ROOT, 'local', 'state', 'security', 'adaptive_mutations.jsonl');
const ADAPTIVE_POINTERS_PATH = path.join(REPO_ROOT, 'local', 'state', 'memory', 'adaptive_pointers.jsonl');
const ADAPTIVE_POINTER_INDEX_PATH = path.join(REPO_ROOT, 'local', 'state', 'memory', 'adaptive_pointer_index.json');
const MISSING_HASH_SENTINEL = '__missing__';
const MUTATE_RETRIES = Number(process.env.ADAPTIVE_MUTATE_RETRIES || 8);

process.env.PROTHEUS_OPS_USE_PREBUILT = process.env.PROTHEUS_OPS_USE_PREBUILT || '0';
process.env.PROTHEUS_OPS_LOCAL_TIMEOUT_MS = process.env.PROTHEUS_OPS_LOCAL_TIMEOUT_MS || '120000';
const bridge = createOpsLaneBridge(__dirname, 'adaptive_layer_store', 'adaptive-layer-store-kernel');

function encodeBase64(value) {
  return Buffer.from(String(value == null ? '' : value), 'utf8').toString('base64');
}

function cloneJsonSafe(v) {
  return JSON.parse(JSON.stringify(v));
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
      : (out && out.stderr ? String(out.stderr).trim() : `adaptive_layer_store_kernel_${command}_failed`);
    if (opts.throwOnError !== false) throw new Error(message || `adaptive_layer_store_kernel_${command}_failed`);
    return { ok: false, error: message || `adaptive_layer_store_kernel_${command}_failed` };
  }
  if (!payloadOut || typeof payloadOut !== 'object') {
    const message = out && out.stderr
      ? String(out.stderr).trim() || `adaptive_layer_store_kernel_${command}_bridge_failed`
      : `adaptive_layer_store_kernel_${command}_bridge_failed`;
    if (opts.throwOnError !== false) throw new Error(message);
    return { ok: false, error: message };
  }
  return payloadOut;
}

function resolveAdaptivePath(targetPath) {
  const out = invoke('resolve-path', {
    workspace_root: workspaceRoot(),
    runtime_root: runtimeRoot(),
    target_path: String(targetPath || '')
  });
  return { abs: String(out.abs || ''), rel: String(out.rel || '') };
}

function isWithinAdaptiveRoot(targetPath) {
  const out = invoke('is-within-root', {
    workspace_root: workspaceRoot(),
    runtime_root: runtimeRoot(),
    target_path: String(targetPath || '')
  });
  return out.within === true;
}

function readJson(targetPath, fallback = null) {
  const out = invoke('read-json', {
    workspace_root: workspaceRoot(),
    runtime_root: runtimeRoot(),
    target_path: String(targetPath || ''),
    fallback
  });
  return out.value == null ? fallback : out.value;
}

function ensureJson(targetPath, defaultValue, meta = {}) {
  const next = typeof defaultValue === 'function' ? defaultValue() : defaultValue;
  const out = invoke('ensure-json', {
    workspace_root: workspaceRoot(),
    runtime_root: runtimeRoot(),
    target_path: String(targetPath || ''),
    default_value: next,
    meta: normalizeObject(meta)
  });
  return out.value;
}

function setJsonReceipt(targetPath, obj, meta = {}, opts = {}) {
  const payload = {
    workspace_root: workspaceRoot(),
    runtime_root: runtimeRoot(),
    target_path: String(targetPath || ''),
    value: obj,
    meta: normalizeObject(meta)
  };
  if (Object.prototype.hasOwnProperty.call(opts, 'expected_hash')) {
    payload.expected_hash = opts.expected_hash;
  }
  const out = invoke('set-json', payload, { throwOnError: opts.throwOnError !== false });
  return out;
}

function setJson(targetPath, obj, meta = {}) {
  const out = setJsonReceipt(targetPath, obj, meta);
  return out.value;
}

function mutateJson(targetPath, mutator, meta = {}) {
  if (typeof mutator !== 'function') {
    throw new Error('adaptive_store: mutator must be function');
  }
  for (let attempt = 0; attempt < MUTATE_RETRIES; attempt += 1) {
    const current = invoke('read-json', {
      workspace_root: workspaceRoot(),
      runtime_root: runtimeRoot(),
      target_path: String(targetPath || ''),
      fallback: null
    });
    const base = current.value == null ? {} : cloneJsonSafe(current.value);
    const mutated = mutator(base);
    if (mutated == null || typeof mutated !== 'object' || Array.isArray(mutated)) {
      throw new Error('adaptive_store: mutator must return object');
    }
    const expectedHash = current.exists === true
      ? String(current.current_hash || '')
      : MISSING_HASH_SENTINEL;
    const out = setJsonReceipt(targetPath, mutated, meta, {
      expected_hash: expectedHash,
      throwOnError: false
    });
    if (out.conflict !== true) {
      return out.value;
    }
  }
  throw new Error('adaptive_store: mutate conflict retry exhausted');
}

function deletePath(targetPath, meta = {}) {
  invoke('delete-path', {
    workspace_root: workspaceRoot(),
    runtime_root: runtimeRoot(),
    target_path: String(targetPath || ''),
    meta: normalizeObject(meta)
  });
}

module.exports = {
  REPO_ROOT,
  ADAPTIVE_ROOT,
  ADAPTIVE_RUNTIME_ROOT,
  MUTATION_LOG_PATH,
  ADAPTIVE_POINTERS_PATH,
  ADAPTIVE_POINTER_INDEX_PATH,
  isWithinAdaptiveRoot,
  resolveAdaptivePath,
  readJson,
  ensureJson,
  setJson,
  mutateJson,
  deletePath
};

export {};
