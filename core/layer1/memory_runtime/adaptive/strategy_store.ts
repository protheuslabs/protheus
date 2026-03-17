#!/usr/bin/env node
'use strict';

// Layer ownership: core/layer0/ops (authoritative)
// Thin TypeScript wrapper only.

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

const DEFAULT_REL_PATH = 'strategy/registry.json';
const DEFAULT_ABS_PATH = path.join(runtimeRoot(), 'adaptive', DEFAULT_REL_PATH);
const STORE_ABS_PATH = process.env.STRATEGY_STORE_PATH
  ? path.resolve(String(process.env.STRATEGY_STORE_PATH))
  : DEFAULT_ABS_PATH;

process.env.PROTHEUS_OPS_USE_PREBUILT = process.env.PROTHEUS_OPS_USE_PREBUILT || '0';
process.env.PROTHEUS_OPS_LOCAL_TIMEOUT_MS = process.env.PROTHEUS_OPS_LOCAL_TIMEOUT_MS || '120000';
const bridge = createOpsLaneBridge(__dirname, 'strategy_store', 'strategy-store-kernel');

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
      : (out && out.stderr ? String(out.stderr).trim() : `strategy_store_kernel_${command}_failed`);
    if (opts.throwOnError !== false) throw new Error(message || `strategy_store_kernel_${command}_failed`);
    return {
      ok: false,
      error: message || `strategy_store_kernel_${command}_failed`
    };
  }
  if (!payloadOut || typeof payloadOut !== 'object') {
    const message = out && out.stderr ? String(out.stderr).trim() || `strategy_store_kernel_${command}_bridge_failed` : `strategy_store_kernel_${command}_bridge_failed`;
    if (opts.throwOnError !== false) throw new Error(message);
    return { ok: false, error: message };
  }
  return payloadOut;
}

function storePayload(filePath) {
  if (!filePath) return {};
  return { file_path: String(filePath) };
}

function defaultStrategyState() {
  return invoke('default-state');
}

function defaultStrategyDraft(seed = {}) {
  return invoke('default-draft', { seed: normalizeObject(seed) });
}

function normalizeMode(value, fallback = 'hyper-creative') {
  const out = invoke('normalize-mode', { value, fallback });
  return String(out.mode || fallback).trim().toLowerCase();
}

function normalizeExecutionMode(value, fallback = 'score_only') {
  const out = invoke('normalize-execution-mode', { value, fallback });
  return String(out.mode || fallback).trim().toLowerCase();
}

function normalizeProfile(raw, nowTs) {
  const payload = { profile: normalizeObject(raw) };
  if (nowTs) payload.now_ts = String(nowTs);
  return invoke('normalize-profile', payload);
}

function validateProfileInput(rawProfile, opts = {}) {
  return invoke('validate-profile', {
    profile: normalizeObject(rawProfile),
    allow_elevated_mode: !!(opts && opts.allow_elevated_mode)
  });
}

function normalizeQueueItem(raw, nowTs) {
  const payload = { item: normalizeObject(raw) };
  if (nowTs) payload.now_ts = String(nowTs);
  return invoke('normalize-queue-item', payload);
}

function recommendMode(summary, rawText) {
  const out = invoke('recommend-mode', {
    summary: String(summary == null ? '' : summary),
    text: String(rawText == null ? '' : rawText)
  });
  return String(out.mode || 'hyper-creative').trim().toLowerCase();
}

function readStrategyState(filePath, fallback = null) {
  return invoke('read-state', {
    ...storePayload(filePath),
    fallback: fallback && typeof fallback === 'object' ? fallback : defaultStrategyState()
  });
}

function ensureStrategyState(filePath, meta = {}) {
  return invoke('ensure-state', {
    ...storePayload(filePath),
    meta: normalizeObject(meta)
  });
}

function setStrategyState(filePath, nextState, meta = {}) {
  return invoke('set-state', {
    ...storePayload(filePath),
    state: nextState && typeof nextState === 'object' ? nextState : defaultStrategyState(),
    meta: normalizeObject(meta)
  });
}

function mutateStrategyState(filePath, mutator, meta = {}) {
  if (typeof mutator !== 'function') throw new Error('strategy_store: mutator must be function');
  const current = readStrategyState(filePath, defaultStrategyState());
  const base = {
    ...current,
    policy: { ...(current.policy || {}) },
    profiles: Array.isArray(current.profiles) ? current.profiles.map((row) => ({ ...row })) : [],
    intake_queue: Array.isArray(current.intake_queue) ? current.intake_queue.map((row) => ({ ...row })) : [],
    metrics: { ...(current.metrics || {}) }
  };
  const next = mutator(base);
  return setStrategyState(filePath, next, {
    ...normalizeObject(meta),
    reason: meta && meta.reason ? meta.reason : 'mutate_strategy_state'
  });
}

function upsertProfile(filePath, profileInput, meta = {}) {
  return invoke('upsert-profile', {
    ...storePayload(filePath),
    profile: normalizeObject(profileInput),
    meta: normalizeObject(meta)
  });
}

function intakeSignal(filePath, intakeInput, meta = {}) {
  return invoke('intake-signal', {
    ...storePayload(filePath),
    intake: normalizeObject(intakeInput),
    meta: normalizeObject(meta)
  });
}

function materializeFromQueue(filePath, queueUid, draftInput, meta = {}) {
  return invoke('materialize-from-queue', {
    ...storePayload(filePath),
    queue_uid: String(queueUid || '').trim(),
    draft: normalizeObject(draftInput),
    meta: normalizeObject(meta)
  });
}

function touchProfileUsage(filePath, strategyId, ts, meta = {}) {
  const payload = {
    ...storePayload(filePath),
    strategy_id: String(strategyId || '').trim(),
    meta: normalizeObject(meta)
  };
  if (ts) payload.ts = String(ts);
  return invoke('touch-profile-usage', payload);
}

function evaluateGcCandidates(state, opts = {}) {
  return invoke('evaluate-gc-candidates', {
    state: state && typeof state === 'object' ? state : defaultStrategyState(),
    opts: normalizeObject(opts)
  });
}

function gcProfiles(filePath, opts = {}, meta = {}) {
  return invoke('gc-profiles', {
    ...storePayload(filePath),
    apply: !!(opts && opts.apply),
    opts: normalizeObject(opts),
    meta: normalizeObject(meta)
  });
}

module.exports = {
  DEFAULT_REL_PATH,
  DEFAULT_ABS_PATH,
  STORE_ABS_PATH,
  defaultStrategyState,
  defaultStrategyDraft,
  normalizeMode,
  normalizeExecutionMode,
  normalizeProfile,
  validateProfileInput,
  normalizeQueueItem,
  recommendMode,
  readStrategyState,
  ensureStrategyState,
  setStrategyState,
  mutateStrategyState,
  upsertProfile,
  intakeSignal,
  materializeFromQueue,
  touchProfileUsage,
  evaluateGcCandidates,
  gcProfiles
};
