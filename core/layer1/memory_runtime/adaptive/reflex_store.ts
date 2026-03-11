// Layer ownership: core/layer1/memory_runtime/adaptive (authoritative)
'use strict';

const path = require('path');
const { stableUid, randomUid, isAlnum } = require('./uid.ts');
const {
  ADAPTIVE_ROOT,
  readJson,
  ensureJson,
  setJson,
  mutateJson
} = require('./layer_store.ts');

const DEFAULT_REL_PATH = 'reflex/registry.json';
const DEFAULT_ABS_PATH = path.join(ADAPTIVE_ROOT, DEFAULT_REL_PATH);

function nowIso() {
  return new Date().toISOString();
}

function clampInt(v, lo, hi, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

function normalizeKey(v, maxLen = 64) {
  return String(v || '')
    .toLowerCase()
    .replace(/[^a-z0-9:_-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, maxLen);
}

function cleanText(v, maxLen = 200) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function defaultReflexState() {
  return {
    version: '1.0',
    policy: {
      min_cells: 1,
      max_cells: 2,
      scale_up_queue_depth: 3,
      scale_down_idle_seconds: 60,
      routine_ttl_days: 14
    },
    routines: [],
    metrics: {
      total_created: 0,
      total_updated: 0,
      total_gc_deleted: 0,
      last_gc_ts: null
    }
  };
}

function normalizeRoutineUid(item, taken) {
  const candidate = String(item && item.uid || '').trim();
  if (candidate && isAlnum(candidate) && !taken.has(candidate)) return candidate;
  const key = normalizeKey(item && item.key, 80);
  const seeded = key ? stableUid(`adaptive_reflex|${key}|v1`, { prefix: 'r', length: 24 }) : '';
  if (seeded && !taken.has(seeded)) return seeded;
  let uid = randomUid({ prefix: 'r', length: 24 });
  let attempts = 0;
  while (taken.has(uid) && attempts < 8) {
    uid = randomUid({ prefix: 'r', length: 24 });
    attempts++;
  }
  return uid;
}

function normalizeRoutine(raw, taken, nowTs) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const key = normalizeKey(src.key || src.name || '', 80);
  if (!key) return null;
  const status = String(src.status || 'active').toLowerCase() === 'disabled' ? 'disabled' : 'active';
  return {
    uid: normalizeRoutineUid(src, taken),
    key,
    name: cleanText(src.name || key, 120),
    trigger: cleanText(src.trigger || '', 200),
    action: cleanText(src.action || '', 240),
    status,
    priority: clampInt(src.priority, 1, 100, 50),
    last_run_ts: src.last_run_ts ? String(src.last_run_ts) : null,
    created_ts: src.created_ts ? String(src.created_ts) : nowTs,
    updated_ts: nowTs
  };
}

function normalizeState(raw, fallback = null) {
  const src = raw && typeof raw === 'object' ? { ...raw } : fallback;
  if (!src || typeof src !== 'object') return fallback;
  const out = {
    version: String(src.version || '1.0'),
    policy: {
      min_cells: clampInt(src.policy && src.policy.min_cells, 1, 128, 1),
      max_cells: clampInt(src.policy && src.policy.max_cells, 1, 256, 2),
      scale_up_queue_depth: clampInt(src.policy && src.policy.scale_up_queue_depth, 1, 1000, 3),
      scale_down_idle_seconds: clampInt(src.policy && src.policy.scale_down_idle_seconds, 10, 3600, 60),
      routine_ttl_days: clampInt(src.policy && src.policy.routine_ttl_days, 1, 365, 14)
    },
    routines: [],
    metrics: {
      total_created: clampInt(src.metrics && src.metrics.total_created, 0, 100000000, 0),
      total_updated: clampInt(src.metrics && src.metrics.total_updated, 0, 100000000, 0),
      total_gc_deleted: clampInt(src.metrics && src.metrics.total_gc_deleted, 0, 100000000, 0),
      last_gc_ts: src.metrics && src.metrics.last_gc_ts ? String(src.metrics.last_gc_ts) : null
    }
  };
  if (out.policy.max_cells < out.policy.min_cells) out.policy.max_cells = out.policy.min_cells;

  const taken = new Set();
  const nowTs = nowIso();
  const rows = Array.isArray(src.routines) ? src.routines : [];
  for (const row of rows) {
    const normalized = normalizeRoutine(row, taken, nowTs);
    if (!normalized) continue;
    taken.add(normalized.uid);
    out.routines.push(normalized);
  }
  out.routines.sort((a, b) => String(a.key || '').localeCompare(String(b.key || '')));
  return out;
}

function asStorePath(filePath) {
  const canonical = DEFAULT_ABS_PATH;
  const raw = String(filePath || '').trim();
  if (!raw) return canonical;
  const requested = path.resolve(raw);
  if (requested !== canonical) {
    throw new Error(`reflex_store: path override denied (requested=${requested})`);
  }
  return canonical;
}

function readReflexState(filePath, fallback = null) {
  const abs = asStorePath(filePath);
  return normalizeState(readJson(abs, fallback), fallback || defaultReflexState());
}

function ensureReflexState(filePath, meta = {}) {
  const abs = asStorePath(filePath);
  const m = (meta && typeof meta === 'object' ? meta : {}) as Record<string, any>;
  return normalizeState(
    ensureJson(abs, defaultReflexState, {
      ...m,
      source: m.source || 'core/layer1/memory_runtime/adaptive/reflex_store.ts',
      reason: m.reason || 'ensure_reflex_state'
    }),
    defaultReflexState()
  );
}

function setReflexState(filePath, nextState, meta = {}) {
  const abs = asStorePath(filePath);
  const m = (meta && typeof meta === 'object' ? meta : {}) as Record<string, any>;
  const normalized = normalizeState(nextState, defaultReflexState());
  return normalizeState(
    setJson(abs, normalized, {
      ...m,
      source: m.source || 'core/layer1/memory_runtime/adaptive/reflex_store.ts',
      reason: m.reason || 'set_reflex_state'
    }),
    defaultReflexState()
  );
}

function mutateReflexState(filePath, mutator, meta = {}) {
  const abs = asStorePath(filePath);
  const m = (meta && typeof meta === 'object' ? meta : {}) as Record<string, any>;
  if (typeof mutator !== 'function') throw new Error('reflex_store: mutator must be function');
  return normalizeState(
    mutateJson(
      abs,
      (current) => {
        const base = normalizeState(current, defaultReflexState());
        const next = mutator({
          ...base,
          policy: { ...(base.policy || {}) },
          routines: Array.isArray(base.routines) ? base.routines.map((row) => ({ ...row })) : [],
          metrics: { ...(base.metrics || {}) }
        });
        return normalizeState(next, base);
      },
      {
        ...m,
        source: m.source || 'core/layer1/memory_runtime/adaptive/reflex_store.ts',
        reason: m.reason || 'mutate_reflex_state'
      }
    ),
    defaultReflexState()
  );
}

module.exports = {
  DEFAULT_REL_PATH,
  DEFAULT_ABS_PATH,
  defaultReflexState,
  normalizeState,
  readReflexState,
  ensureReflexState,
  setReflexState,
  mutateReflexState
};

export {};
