'use strict';

const path = require('path');
const { stableUid, randomUid, isAlnum } = require('../../../../lib/uid.js');
const {
  ADAPTIVE_ROOT,
  readJson,
  ensureJson,
  setJson,
  mutateJson
} = require('../../core/layer_store.js');

const DEFAULT_REL_PATH = 'sensory/eyes/focus_triggers.json';
const DEFAULT_ABS_PATH = path.join(ADAPTIVE_ROOT, DEFAULT_REL_PATH);

function nowIso() {
  return new Date().toISOString();
}

function clampNumber(v, lo, hi, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function normalizeKey(v) {
  return String(v || '')
    .toLowerCase()
    .replace(/[^a-z0-9:_-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120);
}

function normalizeTriggerUid(trigger, taken) {
  const candidate = String(trigger && trigger.uid || '').trim();
  if (candidate && isAlnum(candidate) && !taken.has(candidate)) return candidate;
  const key = normalizeKey(trigger && trigger.key);
  const seeded = key ? stableUid(`focus_trigger|${key}|v1`, { prefix: 'ft', length: 24 }) : '';
  if (seeded && !taken.has(seeded)) return seeded;
  let uid = randomUid({ prefix: 'ft', length: 24 });
  let attempts = 0;
  while (taken.has(uid) && attempts < 8) {
    uid = randomUid({ prefix: 'ft', length: 24 });
    attempts++;
  }
  return uid;
}

function defaultFocusState() {
  return {
    version: '1.0',
    policy: {
      refresh_hours: 4,
      max_triggers: 48,
      min_focus_score: 58,
      dynamic_focus_gate_enabled: true,
      dynamic_focus_window_hours: 6,
      dynamic_focus_target_per_window: 8,
      dynamic_focus_floor_score: 35,
      dynamic_focus_ceiling_score: 85,
      dynamic_focus_response: 14,
      lens_enabled: true,
      lens_refresh_hours: 6,
      lens_window_hours: 48,
      lens_max_terms: 16,
      lens_min_weight: 2,
      lens_max_weight: 20,
      lens_decay: 0.9,
      lens_step_up: 2,
      lens_step_down: 1,
      lens_exclude_threshold: 4,
      lens_max_exclude_terms: 6,
      lens_min_support: 2,
      lens_cross_signal_boost: 3,
      max_focus_items_per_eye: 2,
      max_focus_items_per_run: 6,
      dedupe_window_hours: 36,
      expand_fetch_enabled: true,
      focus_fetch_timeout_ms: 4500,
      focus_fetch_max_bytes: 131072,
      llm_backstop_enabled: false,
      llm_uncertain_min_score: 48,
      llm_uncertain_max_score: 57
    },
    triggers: [],
    eye_lenses: {},
    recent_focus_items: {},
    last_refresh_ts: null,
    last_refresh_sources: {},
    last_lens_refresh_ts: null,
    last_lens_refresh_sources: {},
    stats: {
      refresh_count: 0,
      lens_refresh_count: 0,
      focused_items_total: 0,
      last_focus_ts: null
    }
  };
}

function normalizeTrigger(raw, taken, nowTs) {
  const src = raw && typeof raw === 'object' ? { ...raw } : {};
  const key = normalizeKey(src.key || src.pattern);
  if (!key) return null;
  const statusRaw = String(src.status || 'active').toLowerCase();
  return {
    uid: normalizeTriggerUid({ ...src, key }, taken),
    key,
    pattern: String(src.pattern || key).trim().toLowerCase(),
    mode: String(src.mode || 'contains').toLowerCase() === 'exact' ? 'exact' : 'contains',
    source: String(src.source || 'auto').trim().toLowerCase() || 'auto',
    source_signals: Array.isArray(src.source_signals)
      ? Array.from(new Set(src.source_signals.map((x) => String(x || '').trim().toLowerCase()).filter(Boolean))).slice(0, 8)
      : [],
    status: statusRaw === 'disabled' ? 'disabled' : 'active',
    weight: clampNumber(src.weight, 1, 100, 1),
    cooldown_minutes: clampNumber(src.cooldown_minutes, 0, 24 * 60, 90),
    hit_count: clampNumber(src.hit_count, 0, 1000000, 0),
    last_hit_ts: src.last_hit_ts ? String(src.last_hit_ts) : null,
    created_ts: src.created_ts ? String(src.created_ts) : nowTs,
    updated_ts: src.updated_ts ? String(src.updated_ts) : nowTs
  };
}

function normalizeRecentMap(rawRecent, policy) {
  const src = rawRecent && typeof rawRecent === 'object' ? rawRecent : {};
  const maxAgeHours = clampNumber(policy && policy.dedupe_window_hours, 1, 14 * 24, 36);
  const cutoff = Date.now() - (maxAgeHours * 60 * 60 * 1000);
  const out = {};
  for (const [k, v] of Object.entries(src)) {
    const key = normalizeKey(k);
    if (!key) continue;
    const ts = Date.parse(String(v || ''));
    if (!Number.isFinite(ts)) continue;
    if (ts < cutoff) continue;
    out[key] = new Date(ts).toISOString();
  }
  return out;
}

function normalizePolicy(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const defaults = defaultFocusState().policy;
  return {
    refresh_hours: clampNumber(src.refresh_hours, 1, 24, defaults.refresh_hours),
    max_triggers: clampNumber(src.max_triggers, 8, 200, defaults.max_triggers),
    min_focus_score: clampNumber(src.min_focus_score, 1, 100, defaults.min_focus_score),
    dynamic_focus_gate_enabled: src.dynamic_focus_gate_enabled === false ? false : defaults.dynamic_focus_gate_enabled,
    dynamic_focus_window_hours: clampNumber(
      src.dynamic_focus_window_hours,
      1,
      72,
      defaults.dynamic_focus_window_hours
    ),
    dynamic_focus_target_per_window: clampNumber(
      src.dynamic_focus_target_per_window,
      0,
      500,
      defaults.dynamic_focus_target_per_window
    ),
    dynamic_focus_floor_score: clampNumber(
      src.dynamic_focus_floor_score,
      1,
      100,
      defaults.dynamic_focus_floor_score
    ),
    dynamic_focus_ceiling_score: clampNumber(
      src.dynamic_focus_ceiling_score,
      1,
      100,
      defaults.dynamic_focus_ceiling_score
    ),
    dynamic_focus_response: clampNumber(
      src.dynamic_focus_response,
      0,
      60,
      defaults.dynamic_focus_response
    ),
    lens_enabled: src.lens_enabled === false ? false : defaults.lens_enabled,
    lens_refresh_hours: clampNumber(src.lens_refresh_hours, 1, 72, defaults.lens_refresh_hours),
    lens_window_hours: clampNumber(src.lens_window_hours, 6, 24 * 14, defaults.lens_window_hours),
    lens_max_terms: clampNumber(src.lens_max_terms, 4, 64, defaults.lens_max_terms),
    lens_min_weight: clampNumber(src.lens_min_weight, 1, 40, defaults.lens_min_weight),
    lens_max_weight: clampNumber(src.lens_max_weight, 1, 60, defaults.lens_max_weight),
    lens_decay: clampNumber(src.lens_decay, 0.5, 0.99, defaults.lens_decay),
    lens_step_up: clampNumber(src.lens_step_up, 1, 10, defaults.lens_step_up),
    lens_step_down: clampNumber(src.lens_step_down, 1, 10, defaults.lens_step_down),
    lens_exclude_threshold: clampNumber(src.lens_exclude_threshold, 1, 50, defaults.lens_exclude_threshold),
    lens_max_exclude_terms: clampNumber(src.lens_max_exclude_terms, 0, 32, defaults.lens_max_exclude_terms),
    lens_min_support: clampNumber(src.lens_min_support, 1, 20, defaults.lens_min_support),
    lens_cross_signal_boost: clampNumber(src.lens_cross_signal_boost, 0, 20, defaults.lens_cross_signal_boost),
    max_focus_items_per_eye: clampNumber(src.max_focus_items_per_eye, 1, 10, defaults.max_focus_items_per_eye),
    max_focus_items_per_run: clampNumber(src.max_focus_items_per_run, 1, 50, defaults.max_focus_items_per_run),
    dedupe_window_hours: clampNumber(src.dedupe_window_hours, 1, 14 * 24, defaults.dedupe_window_hours),
    expand_fetch_enabled: src.expand_fetch_enabled === false ? false : defaults.expand_fetch_enabled,
    focus_fetch_timeout_ms: clampNumber(src.focus_fetch_timeout_ms, 500, 15000, defaults.focus_fetch_timeout_ms),
    focus_fetch_max_bytes: clampNumber(src.focus_fetch_max_bytes, 4096, 1048576, defaults.focus_fetch_max_bytes),
    llm_backstop_enabled: src.llm_backstop_enabled === true,
    llm_uncertain_min_score: clampNumber(src.llm_uncertain_min_score, 1, 99, defaults.llm_uncertain_min_score),
    llm_uncertain_max_score: clampNumber(src.llm_uncertain_max_score, 1, 100, defaults.llm_uncertain_max_score)
  };
}

function normalizeTermsArray(raw, maxCount = 16) {
  const src = Array.isArray(raw) ? raw : [];
  const out = [];
  const seen = new Set();
  for (const term of src) {
    const t = normalizeKey(term);
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= maxCount) break;
  }
  return out;
}

function normalizeTermWeights(raw, includeTerms, maxWeight = 20) {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>;
  const allowed = new Set(includeTerms || []);
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(src)) {
    const term = normalizeKey(k);
    if (!term || !allowed.has(term)) continue;
    out[term] = clampNumber(v, 1, maxWeight, 1);
  }
  for (const term of allowed) {
    const key = String(term || '');
    if (!Object.prototype.hasOwnProperty.call(out, key)) out[key] = 1;
  }
  return out;
}

function normalizeEyeLenses(raw, policy) {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>;
  const maxTerms = clampNumber(policy && policy.lens_max_terms, 4, 64, 16);
  const maxExclude = clampNumber(policy && policy.lens_max_exclude_terms, 0, 32, 6);
  const maxWeight = clampNumber(policy && policy.lens_max_weight, 1, 60, 20);
  const out: Record<string, any> = {};
  for (const [eyeRaw, lensRaw] of Object.entries(src)) {
    const eyeId = normalizeKey(eyeRaw);
    if (!eyeId) continue;
    const lens = (lensRaw && typeof lensRaw === 'object' ? lensRaw : {}) as Record<string, any>;
    const includeTerms = normalizeTermsArray(lens.include_terms, maxTerms);
    const excludeTerms = normalizeTermsArray(lens.exclude_terms, maxExclude)
      .filter((t) => !includeTerms.includes(t))
      .slice(0, maxExclude);
    out[eyeId] = {
      eye_id: eyeId,
      include_terms: includeTerms,
      exclude_terms: excludeTerms,
      term_weights: normalizeTermWeights(lens.term_weights, includeTerms, maxWeight),
      baseline_topics: normalizeTermsArray(lens.baseline_topics, maxTerms),
      focus_hits_total: clampNumber(lens.focus_hits_total, 0, 100000000, 0),
      update_count: clampNumber(lens.update_count, 0, 100000000, 0),
      created_ts: lens.created_ts ? String(lens.created_ts) : nowIso(),
      updated_ts: lens.updated_ts ? String(lens.updated_ts) : nowIso()
    };
  }
  return out;
}

function normalizeState(raw, fallback = null) {
  const base = defaultFocusState();
  const src = (raw && typeof raw === 'object' ? raw : fallback || base) as Record<string, any>;
  const nowTs = nowIso();
  const policy = normalizePolicy(src.policy);
  const taken = new Set();
  const triggers = [];
  for (const t of (Array.isArray(src.triggers) ? src.triggers : [])) {
    const normalized = normalizeTrigger(t, taken, nowTs);
    if (!normalized) continue;
    taken.add(normalized.uid);
    triggers.push(normalized);
  }
  triggers.sort((a, b) => {
    if (b.weight !== a.weight) return b.weight - a.weight;
    return String(a.key).localeCompare(String(b.key));
  });
  const statsSrc = src.stats && typeof src.stats === 'object' ? src.stats : {};
  return {
    version: String(src.version || base.version),
    policy,
    triggers: triggers.slice(0, policy.max_triggers),
    eye_lenses: normalizeEyeLenses(src.eye_lenses, policy),
    recent_focus_items: normalizeRecentMap(src.recent_focus_items, policy),
    last_refresh_ts: src.last_refresh_ts ? String(src.last_refresh_ts) : null,
    last_refresh_sources: src.last_refresh_sources && typeof src.last_refresh_sources === 'object'
      ? src.last_refresh_sources
      : {},
    last_lens_refresh_ts: src.last_lens_refresh_ts ? String(src.last_lens_refresh_ts) : null,
    last_lens_refresh_sources: src.last_lens_refresh_sources && typeof src.last_lens_refresh_sources === 'object'
      ? src.last_lens_refresh_sources
      : {},
    stats: {
      refresh_count: clampNumber(statsSrc.refresh_count, 0, 1000000, 0),
      lens_refresh_count: clampNumber(statsSrc.lens_refresh_count, 0, 1000000, 0),
      focused_items_total: clampNumber(statsSrc.focused_items_total, 0, 100000000, 0),
      last_focus_ts: statsSrc.last_focus_ts ? String(statsSrc.last_focus_ts) : null
    }
  };
}

function asStorePath(filePath) {
  const canonical = DEFAULT_ABS_PATH;
  const raw = String(filePath || '').trim();
  if (!raw) return canonical;
  const requested = path.resolve(raw);
  if (requested !== canonical) {
    throw new Error(`focus_trigger_store: path override denied (requested=${requested})`);
  }
  return canonical;
}

function readFocusState(filePath, fallback = null) {
  const abs = asStorePath(filePath);
  return normalizeState(readJson(abs, fallback), fallback || defaultFocusState());
}

function ensureFocusState(filePath, meta = {}) {
  const abs = asStorePath(filePath);
  const m = (meta && typeof meta === 'object' ? meta : {}) as Record<string, any>;
  return normalizeState(
    ensureJson(abs, defaultFocusState, {
      ...m,
      source: m.source || 'systems/adaptive/sensory/eyes/focus_trigger_store.js',
      reason: m.reason || 'ensure_focus_state'
    }),
    defaultFocusState()
  );
}

function setFocusState(filePath, nextState, meta = {}) {
  const abs = asStorePath(filePath);
  const m = (meta && typeof meta === 'object' ? meta : {}) as Record<string, any>;
  const normalized = normalizeState(nextState, defaultFocusState());
  return normalizeState(
    setJson(abs, normalized, {
      ...m,
      source: m.source || 'systems/adaptive/sensory/eyes/focus_trigger_store.js',
      reason: m.reason || 'set_focus_state'
    }),
    defaultFocusState()
  );
}

function mutateFocusState(filePath, mutator, meta = {}) {
  const abs = asStorePath(filePath);
  const m = (meta && typeof meta === 'object' ? meta : {}) as Record<string, any>;
  if (typeof mutator !== 'function') throw new Error('focus_trigger_store: mutator must be function');
  return normalizeState(
    mutateJson(
      abs,
      (current) => {
        const base = normalizeState(current, defaultFocusState());
        const next = mutator({
          ...base,
          policy: { ...(base.policy || {}) },
          triggers: Array.isArray(base.triggers) ? base.triggers.map((t) => ({ ...t })) : [],
          eye_lenses: { ...(base.eye_lenses || {}) },
          recent_focus_items: { ...(base.recent_focus_items || {}) },
          stats: { ...(base.stats || {}) },
          last_refresh_sources: { ...(base.last_refresh_sources || {}) },
          last_lens_refresh_sources: { ...(base.last_lens_refresh_sources || {}) }
        });
        return normalizeState(next, base);
      },
      {
        ...m,
        source: m.source || 'systems/adaptive/sensory/eyes/focus_trigger_store.js',
        reason: m.reason || 'mutate_focus_state'
      }
    ),
    defaultFocusState()
  );
}

module.exports = {
  DEFAULT_REL_PATH,
  DEFAULT_ABS_PATH,
  defaultFocusState,
  readFocusState,
  ensureFocusState,
  setFocusState,
  mutateFocusState,
  normalizeState
};

export {};
