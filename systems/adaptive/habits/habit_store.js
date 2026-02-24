'use strict';

const path = require('path');
const { stableUid, randomUid, isAlnum } = require('../../../lib/uid');
const {
  ADAPTIVE_ROOT,
  readJson,
  ensureJson,
  setJson,
  mutateJson
} = require('../core/layer_store');

const DEFAULT_REL_PATH = 'habits/registry.json';
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

function defaultHabitState() {
  return {
    version: '1.0',
    policy: {
      generation_min_repeats: 3,
      max_active_routines: 128,
      gc_inactive_days: 30
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
  const idSeed = normalizeKey(item && item.id, 80);
  const seeded = idSeed ? stableUid(`adaptive_habit|${idSeed}|v1`, { prefix: 'h', length: 24 }) : '';
  if (seeded && !taken.has(seeded)) return seeded;
  let uid = randomUid({ prefix: 'h', length: 24 });
  let attempts = 0;
  while (taken.has(uid) && attempts < 8) {
    uid = randomUid({ prefix: 'h', length: 24 });
    attempts++;
  }
  return uid;
}

function normalizeUsage(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    uses_total: clampInt(src.uses_total, 0, 100000000, 0),
    uses_30d: clampInt(src.uses_30d, 0, 100000000, 0),
    last_used_ts: src.last_used_ts ? String(src.last_used_ts) : null
  };
}

function normalizeRoutine(raw, taken, nowTs) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const id = normalizeKey(src.id || src.name || '', 80);
  if (!id) return null;
  const status = String(src.status || 'active').toLowerCase() === 'disabled' ? 'disabled' : 'active';
  return {
    uid: normalizeRoutineUid(src, taken),
    id,
    name: cleanText(src.name || id, 120),
    summary: cleanText(src.summary || '', 240),
    routine_path: cleanText(src.routine_path || '', 240),
    status,
    usage: normalizeUsage(src.usage),
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
      generation_min_repeats: clampInt(src.policy && src.policy.generation_min_repeats, 1, 20, 3),
      max_active_routines: clampInt(src.policy && src.policy.max_active_routines, 1, 1000, 128),
      gc_inactive_days: clampInt(src.policy && src.policy.gc_inactive_days, 1, 365, 30)
    },
    routines: [],
    metrics: {
      total_created: clampInt(src.metrics && src.metrics.total_created, 0, 100000000, 0),
      total_updated: clampInt(src.metrics && src.metrics.total_updated, 0, 100000000, 0),
      total_gc_deleted: clampInt(src.metrics && src.metrics.total_gc_deleted, 0, 100000000, 0),
      last_gc_ts: src.metrics && src.metrics.last_gc_ts ? String(src.metrics.last_gc_ts) : null
    }
  };
  const taken = new Set();
  const nowTs = nowIso();
  const rows = Array.isArray(src.routines) ? src.routines : [];
  for (const row of rows) {
    const normalized = normalizeRoutine(row, taken, nowTs);
    if (!normalized) continue;
    taken.add(normalized.uid);
    out.routines.push(normalized);
  }
  out.routines.sort((a, b) => String(a.id || '').localeCompare(String(b.id || '')));
  return out;
}

function asStorePath(filePath) {
  const canonical = DEFAULT_ABS_PATH;
  const raw = String(filePath || '').trim();
  if (!raw) return canonical;
  const requested = path.resolve(raw);
  if (requested !== canonical) {
    throw new Error(`habit_store: path override denied (requested=${requested})`);
  }
  return canonical;
}

function readHabitState(filePath, fallback = null) {
  const abs = asStorePath(filePath);
  return normalizeState(readJson(abs, fallback), fallback || defaultHabitState());
}

function ensureHabitState(filePath, meta = {}) {
  const abs = asStorePath(filePath);
  return normalizeState(
    ensureJson(abs, defaultHabitState, {
      ...meta,
      source: meta.source || 'systems/adaptive/habits/habit_store.js',
      reason: meta.reason || 'ensure_habit_state'
    }),
    defaultHabitState()
  );
}

function setHabitState(filePath, nextState, meta = {}) {
  const abs = asStorePath(filePath);
  const normalized = normalizeState(nextState, defaultHabitState());
  return normalizeState(
    setJson(abs, normalized, {
      ...meta,
      source: meta.source || 'systems/adaptive/habits/habit_store.js',
      reason: meta.reason || 'set_habit_state'
    }),
    defaultHabitState()
  );
}

function mutateHabitState(filePath, mutator, meta = {}) {
  const abs = asStorePath(filePath);
  if (typeof mutator !== 'function') throw new Error('habit_store: mutator must be function');
  return normalizeState(
    mutateJson(
      abs,
      (current) => {
        const base = normalizeState(current, defaultHabitState());
        const next = mutator({
          ...base,
          policy: { ...(base.policy || {}) },
          routines: Array.isArray(base.routines) ? base.routines.map((row) => ({ ...row })) : [],
          metrics: { ...(base.metrics || {}) }
        });
        return normalizeState(next, base);
      },
      {
        ...meta,
        source: meta.source || 'systems/adaptive/habits/habit_store.js',
        reason: meta.reason || 'mutate_habit_state'
      }
    ),
    defaultHabitState()
  );
}

module.exports = {
  DEFAULT_REL_PATH,
  DEFAULT_ABS_PATH,
  defaultHabitState,
  normalizeState,
  readHabitState,
  ensureHabitState,
  setHabitState,
  mutateHabitState
};
