'use strict';
export {};

const path = require('path');
const crypto = require('crypto');
const { stableUid, randomUid, isAlnum } = require('../../../lib/uid');
const {
  ADAPTIVE_ROOT,
  readJson,
  ensureJson,
  setJson,
  mutateJson
} = require('../core/layer_store');

type AnyObj = Record<string, any>;

const DEFAULT_REL_PATH = 'strategy/registry.json';
const DEFAULT_ABS_PATH = path.join(ADAPTIVE_ROOT, DEFAULT_REL_PATH);
const STORE_ABS_PATH = process.env.STRATEGY_STORE_PATH
  ? path.resolve(String(process.env.STRATEGY_STORE_PATH))
  : DEFAULT_ABS_PATH;
const GENERATION_MODES = new Set(['normal', 'narrative', 'creative', 'hyper-creative', 'deep-thinker']);
const EXECUTION_MODES = new Set(['score_only', 'canary_execute', 'execute']);

function nowIso() {
  return new Date().toISOString();
}

function hash16(v) {
  return crypto.createHash('sha256').update(String(v || ''), 'utf8').digest('hex').slice(0, 16);
}

function clampNumber(v, lo, hi, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function normalizeKey(v, maxLen = 64) {
  return String(v || '')
    .toLowerCase()
    .replace(/[^a-z0-9:_-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, maxLen);
}

function cleanText(v, maxLen = 240) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeMode(v, fallback = 'hyper-creative') {
  const key = String(v || '').trim().toLowerCase();
  if (GENERATION_MODES.has(key)) return key;
  return fallback;
}

function normalizeExecutionMode(v, fallback = 'score_only') {
  const key = String(v || '').trim().toLowerCase();
  if (EXECUTION_MODES.has(key)) return key;
  return fallback;
}

function normalizeAllowedRisks(raw) {
  const src = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const x of src) {
    const v = String(x || '').trim().toLowerCase();
    if (v !== 'low' && v !== 'medium' && v !== 'high') continue;
    if (!out.includes(v)) out.push(v);
  }
  return out.length ? out : ['low'];
}

function defaultStrategyDraft(seed: AnyObj = {}): AnyObj {
  const id = normalizeKey(seed.id || seed.name || `strategy_${randomUid({ prefix: 's', length: 8 })}`, 40) || `strategy_${hash16(nowIso())}`;
  const name = cleanText(seed.name || id, 120) || id;
  const objectivePrimary = cleanText(
    seed.objective && seed.objective.primary
      ? seed.objective.primary
      : (seed.summary || seed.prompt || `Improve outcomes for ${name}`),
    180
  );
  return {
    version: '1.0',
    id,
    name,
    status: 'disabled',
    objective: {
      primary: objectivePrimary || `Improve outcomes for ${name}`,
      secondary: [],
      fitness_metric: 'verified_progress_rate',
      target_window_days: 14
    },
    generation_policy: {
      mode: normalizeMode(seed.generation_mode || seed.mode, 'hyper-creative')
    },
    risk_policy: {
      allowed_risks: normalizeAllowedRisks(seed.risk_policy && seed.risk_policy.allowed_risks),
      max_risk_per_action: clampNumber(
        seed.risk_policy && seed.risk_policy.max_risk_per_action,
        0,
        100,
        35
      )
    },
    admission_policy: {
      allowed_types: [],
      blocked_types: [],
      max_remediation_depth: 2,
      duplicate_window_hours: 24
    },
    ranking_weights: {
      composite: 0.35,
      actionability: 0.2,
      directive_fit: 0.15,
      signal_quality: 0.15,
      expected_value: 0.1,
      time_to_value: 0,
      risk_penalty: 0.05
    },
    value_currency_policy: {
      default_currency: 'revenue',
      currency_overrides: {
        revenue: { ranking_weights: { expected_value: 0.16, time_to_value: 0.06, risk_penalty: 0.04 } },
        quality: { ranking_weights: { signal_quality: 0.24, risk_penalty: 0.08, expected_value: 0.06 } },
        delivery: { ranking_weights: { actionability: 0.24, expected_value: 0.11, risk_penalty: 0.04 } }
      },
      objective_overrides: {}
    },
    budget_policy: {
      daily_runs_cap: 4,
      daily_token_cap: 4000,
      max_tokens_per_action: 1600
    },
    exploration_policy: {
      fraction: 0.25,
      every_n: 3,
      min_eligible: 3
    },
    stop_policy: {
      circuit_breakers: {
        http_429_cooldown_hours: 12
      }
    },
    promotion_policy: {
      min_days: 7,
      min_attempted: 12,
      min_verified_rate: 0.5,
      min_success_criteria_receipts: 2,
      min_success_criteria_pass_rate: 0.6,
      min_objective_coverage: 0.25,
      max_objective_no_progress_rate: 0.9,
      max_reverted_rate: 0.35,
      max_stop_ratio: 0.75,
      min_shipped: 1
    },
    execution_policy: {
      mode: 'score_only'
    },
    threshold_overrides: {}
  };
}

function normalizeUsage(raw, nowTs) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const eventsIn = Array.isArray(src.use_events) ? src.use_events : [];
  const events = eventsIn
    .map((x) => String(x || ''))
    .filter((x) => Number.isFinite(Date.parse(x)))
    .sort();
  const cutoff = Date.now() - (30 * 24 * 60 * 60 * 1000);
  const uses30 = events.filter((ts) => Date.parse(ts) >= cutoff).length;
  return {
    uses_total: clampNumber(src.uses_total, 0, 100000000, events.length),
    uses_30d: clampNumber(src.uses_30d, 0, 100000000, uses30),
    use_events: events.slice(-256),
    last_used_ts: src.last_used_ts && Number.isFinite(Date.parse(src.last_used_ts))
      ? String(src.last_used_ts)
      : null,
    last_usage_sync_ts: src.last_usage_sync_ts && Number.isFinite(Date.parse(src.last_usage_sync_ts))
      ? String(src.last_usage_sync_ts)
      : nowTs
  };
}

function ensureWorkPacket(item) {
  const mode = normalizeMode(item.recommended_generation_mode || item.generation_mode, 'hyper-creative');
  return {
    mode_hint: mode,
    allowed_modes: ['hyper-creative', 'deep-thinker'],
    objective: 'Turn this intake signal into a structured strategy profile draft.',
    input_summary: cleanText(item.summary || '', 220),
    output_contract: {
      format: 'strategy_profile_json',
      required_keys: [
        'id',
        'name',
        'objective.primary',
        'risk_policy.allowed_risks',
        'execution_policy.mode'
      ],
      notes: 'Keep output strategy-agnostic and deterministic; prefer score_only at first.'
    }
  };
}

function recommendMode(summary, rawText) {
  const text = `${String(summary || '')} ${String(rawText || '')}`.toLowerCase();
  if (
    text.length > 900
    || /\b(tradeoff|architecture|uncertain|counterfactual|conflict|multi-step|nonlinear|portfolio|long[-\s]?horizon)\b/.test(text)
  ) return 'deep-thinker';
  return 'hyper-creative';
}

function computeTrustScore(item) {
  const src = item && typeof item === 'object' ? item : {};
  const source = String(src.source || '').toLowerCase();
  const evidence = Array.isArray(src.evidence_refs) ? src.evidence_refs.length : 0;
  const summaryLen = String(src.summary || '').trim().length;
  const textLen = String(src.text || '').trim().length;
  let score = 20;
  score += Math.min(40, evidence * 10);
  score += Math.min(20, Math.floor(summaryLen / 20));
  score += Math.min(10, Math.floor(textLen / 300));
  if (source.includes('outcome_fitness') || source.includes('strategy_scorecards')) score += 12;
  if (source.includes('cross_signal') || source.includes('sensory_trends')) score += 8;
  if (source === 'manual') score += 5;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function queueDropReason(item, policy, nowMs) {
  const src = item && typeof item === 'object' ? item : {};
  const p = policy && typeof policy === 'object' ? policy : defaultStrategyState().policy;
  const reasons = [];
  const createdMs = Number.isFinite(Date.parse(String(src.created_ts || '')))
    ? Date.parse(String(src.created_ts || ''))
    : 0;
  const ttlHours = Number(p.queue_ttl_hours || 72);
  const maxAttempts = Number(p.queue_max_attempts || 3);
  const minEvidence = Number(p.queue_min_evidence_refs || 1);
  const minTrust = Number(p.queue_min_trust_score || 35);

  if (createdMs > 0 && (nowMs - createdMs) > (ttlHours * 60 * 60 * 1000)) reasons.push('queue_ttl_expired');
  if (Number(src.attempts || 0) >= maxAttempts) reasons.push('queue_max_attempts_exceeded');
  if (Number((src.evidence_refs || []).length || 0) < minEvidence) reasons.push('evidence_missing');
  if (Number(src.trust_score || 0) < minTrust) reasons.push('trust_score_low');
  if (String(src.summary || '').trim().length < 16) reasons.push('summary_too_short');
  return reasons;
}

function normalizeQueueItem(raw: AnyObj, nowTs: string): AnyObj {
  const src = raw && typeof raw === 'object' ? raw : {};
  const summary = cleanText(src.summary || src.text || src.payload || 'strategy intake', 220);
  const text = String(src.text || src.payload || '').trim().slice(0, 6000);
  const evidence = Array.isArray(src.evidence_refs)
    ? Array.from(new Set(src.evidence_refs.map((x) => cleanText(x, 200)).filter(Boolean))).slice(0, 24)
    : [];
  const mode = normalizeMode(src.recommended_generation_mode || src.generation_mode || recommendMode(summary, text), 'hyper-creative');
  const uidCandidate = cleanText(src.uid, 64);
  const uid = uidCandidate && isAlnum(uidCandidate)
    ? uidCandidate
    : randomUid({ prefix: 'si', length: 24 });
  const fingerprint = cleanText(src.fingerprint, 40) || hash16(JSON.stringify({
    source: cleanText(src.source || 'unknown', 60),
    kind: cleanText(src.kind || 'signal', 40),
    summary,
    text,
    evidence
  }));
  const statusRaw = String(src.status || 'queued').toLowerCase();
  const status = statusRaw === 'consumed' || statusRaw === 'dropped' ? statusRaw : 'queued';
  const item: AnyObj = {
    uid,
    fingerprint,
    source: cleanText(src.source || 'unknown', 80),
    kind: cleanText(src.kind || 'signal', 60),
    summary,
    text,
    evidence_refs: evidence,
    recommended_generation_mode: mode,
    status,
    attempts: clampNumber(src.attempts, 0, 1000, 0),
    created_ts: src.created_ts && Number.isFinite(Date.parse(src.created_ts)) ? String(src.created_ts) : nowTs,
    updated_ts: src.updated_ts && Number.isFinite(Date.parse(src.updated_ts)) ? String(src.updated_ts) : nowTs,
    consumed_ts: src.consumed_ts && Number.isFinite(Date.parse(src.consumed_ts)) ? String(src.consumed_ts) : null,
    linked_strategy_id: cleanText(src.linked_strategy_id, 64) || null
  };
  item.trust_score = clampNumber(src.trust_score, 0, 100, computeTrustScore(item));
  item.drop_reason = cleanText(src.drop_reason, 200) || null;
  item.work_packet = ensureWorkPacket(item);
  return item;
}

function normalizeProfile(raw: AnyObj, nowTs: string): AnyObj {
  const src = raw && typeof raw === 'object' ? raw : {};
  const draftSrc = src.draft && typeof src.draft === 'object' ? src.draft : src;
  const draft = defaultStrategyDraft(draftSrc);
  const id = normalizeKey(src.id || draft.id || draft.name, 40) || draft.id;
  draft.id = id;
  draft.name = cleanText(src.name || draft.name || id, 120) || id;
  draft.objective = draft.objective && typeof draft.objective === 'object' ? draft.objective : {};
  draft.objective.primary = cleanText(
    draft.objective.primary || src.objective_primary || '',
    220
  ) || `Improve outcomes for ${draft.name}`;
  draft.risk_policy = draft.risk_policy && typeof draft.risk_policy === 'object' ? draft.risk_policy : {};
  draft.risk_policy.allowed_risks = normalizeAllowedRisks(draft.risk_policy.allowed_risks);
  draft.risk_policy.max_risk_per_action = clampNumber(draft.risk_policy.max_risk_per_action, 0, 100, 35);
  const requestedExecutionMode = normalizeExecutionMode(
    src.execution_mode
      || (src.execution_policy && src.execution_policy.mode)
      || (draft.execution_policy && draft.execution_policy.mode),
    'score_only'
  );
  const allowElevatedMode = src.allow_elevated_mode === true;
  draft.execution_policy = draft.execution_policy && typeof draft.execution_policy === 'object' ? draft.execution_policy : {};
  draft.execution_policy.mode = allowElevatedMode ? requestedExecutionMode : 'score_only';
  draft.generation_policy = {
    mode: normalizeMode(
      src.generation_mode
      || (src.generation_policy && src.generation_policy.mode)
      || (draft.generation_policy && draft.generation_policy.mode),
      'hyper-creative'
    )
  };
  const uidCandidate = cleanText(src.uid, 64);
  const uid = uidCandidate && isAlnum(uidCandidate)
    ? uidCandidate
    : stableUid(`adaptive_strategy_profile|${id}|v1`, { prefix: 'stp', length: 24 });
  const stageRaw = String(src.stage || 'theory').toLowerCase();
  const stage = stageRaw === 'trial' || stageRaw === 'validated' || stageRaw === 'scaled'
    ? stageRaw
    : 'theory';
  const statusRaw = String(src.status || 'active').toLowerCase();
  const status = statusRaw === 'disabled' || statusRaw === 'archived' ? statusRaw : 'active';
  return {
    uid,
    id,
    name: cleanText(src.name || draft.name || id, 120) || id,
    stage,
    status,
    source: cleanText(src.source || 'adaptive_intake', 80),
    queue_ref: cleanText(src.queue_ref, 64) || null,
    generated_mode: normalizeMode(
      src.generated_mode
      || src.generation_mode
      || (draft.generation_policy && draft.generation_policy.mode),
      'hyper-creative'
    ),
    requested_execution_mode: requestedExecutionMode,
    elevated_mode_forced_down: !allowElevatedMode && requestedExecutionMode !== 'score_only',
    tags: Array.isArray(src.tags)
      ? Array.from(new Set(src.tags.map((x) => normalizeKey(x, 32)).filter(Boolean))).slice(0, 16)
      : [],
    draft,
    usage: normalizeUsage(src.usage, nowTs),
    created_ts: src.created_ts && Number.isFinite(Date.parse(src.created_ts)) ? String(src.created_ts) : nowTs,
    updated_ts: src.updated_ts && Number.isFinite(Date.parse(src.updated_ts)) ? String(src.updated_ts) : nowTs
  };
}

function validateProfileInput(rawProfile: AnyObj, opts: AnyObj = {}): AnyObj {
  const normalized = normalizeProfile(rawProfile, nowIso());
  const errors = [];
  const allowElevatedMode = opts.allow_elevated_mode === true;
  if (!normalized.id) errors.push('id_required');
  if (!normalized.draft || typeof normalized.draft !== 'object') errors.push('draft_required');
  const objectivePrimary = cleanText(normalized.draft && normalized.draft.objective && normalized.draft.objective.primary, 220);
  if (!objectivePrimary) errors.push('objective_primary_required');
  if (!Array.isArray(normalized.draft.risk_policy && normalized.draft.risk_policy.allowed_risks) || normalized.draft.risk_policy.allowed_risks.length < 1) {
    errors.push('risk_policy_allowed_risks_required');
  }
  const mode = normalizeExecutionMode(normalized.draft && normalized.draft.execution_policy && normalized.draft.execution_policy.mode, 'score_only');
  if (!EXECUTION_MODES.has(mode)) errors.push('execution_mode_invalid');
  if (!allowElevatedMode && mode !== 'score_only') errors.push('execution_mode_requires_explicit_override');
  if (errors.length) {
    const err = new Error(`strategy_store: validation_failed:${errors.join(',')}`);
    (err as AnyObj).validation_errors = errors;
    throw err;
  }
  return normalized;
}

function defaultStrategyState() {
  return {
    version: '1.0',
    policy: {
      max_profiles: 64,
      max_queue: 64,
      queue_ttl_hours: 72,
      queue_max_attempts: 3,
      queue_min_evidence_refs: 1,
      queue_min_trust_score: 35,
      gc_inactive_days: 21,
      gc_min_uses_30d: 1,
      gc_protect_new_days: 3
    },
    profiles: [],
    intake_queue: [],
    metrics: {
      total_intakes: 0,
      total_profiles_created: 0,
      total_profiles_updated: 0,
      total_queue_consumed: 0,
      total_gc_deleted: 0,
      last_gc_ts: null,
      last_usage_sync_ts: null
    }
  };
}

function normalizePolicy(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const d = defaultStrategyState().policy;
  return {
    max_profiles: clampNumber(src.max_profiles, 4, 512, d.max_profiles),
    max_queue: clampNumber(src.max_queue, 4, 512, d.max_queue),
    queue_ttl_hours: clampNumber(src.queue_ttl_hours, 1, 24 * 30, d.queue_ttl_hours),
    queue_max_attempts: clampNumber(src.queue_max_attempts, 1, 100, d.queue_max_attempts),
    queue_min_evidence_refs: clampNumber(src.queue_min_evidence_refs, 0, 32, d.queue_min_evidence_refs),
    queue_min_trust_score: clampNumber(src.queue_min_trust_score, 0, 100, d.queue_min_trust_score),
    gc_inactive_days: clampNumber(src.gc_inactive_days, 1, 365, d.gc_inactive_days),
    gc_min_uses_30d: clampNumber(src.gc_min_uses_30d, 0, 1000, d.gc_min_uses_30d),
    gc_protect_new_days: clampNumber(src.gc_protect_new_days, 0, 90, d.gc_protect_new_days)
  };
}

function normalizeState(raw, fallback = null) {
  const nowTs = nowIso();
  const base = defaultStrategyState();
  const src = raw && typeof raw === 'object' ? raw : fallback || base;
  const policy = normalizePolicy(src.policy);

  const byId = new Map();
  const profilesIn = Array.isArray(src.profiles) ? src.profiles : [];
  for (const p of profilesIn) {
    const n = normalizeProfile(p, nowTs);
    if (!n.id) continue;
    if (!byId.has(n.id) || Date.parse(n.updated_ts) >= Date.parse(byId.get(n.id).updated_ts || 0)) {
      byId.set(n.id, n);
    }
  }
  const profiles = Array.from(byId.values())
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))
    .slice(0, policy.max_profiles);

  const byQueueUid = new Map();
  const queueIn = Array.isArray(src.intake_queue) ? src.intake_queue : [];
  const nowMs = Date.now();
  for (const q of queueIn) {
    const n = normalizeQueueItem(q, nowTs);
    n.trust_score = computeTrustScore(n);
    n.work_packet = ensureWorkPacket(n);
    if (String(n.status || '') === 'queued') {
      const drops = queueDropReason(n, policy, nowMs);
      if (drops.length) {
        n.status = 'dropped';
        n.drop_reason = drops.join(',');
        n.updated_ts = nowTs;
      }
    }
    if (!n.uid) continue;
    if (!byQueueUid.has(n.uid) || Date.parse(n.updated_ts) >= Date.parse(byQueueUid.get(n.uid).updated_ts || 0)) {
      byQueueUid.set(n.uid, n);
    }
  }
  const intakeQueue = Array.from(byQueueUid.values())
    .sort((a, b) => Date.parse(a.created_ts || 0) - Date.parse(b.created_ts || 0))
    .slice(-policy.max_queue);

  const m = src.metrics && typeof src.metrics === 'object' ? src.metrics : {};
  const metrics = {
    total_intakes: clampNumber(m.total_intakes, 0, 100000000, 0),
    total_profiles_created: clampNumber(m.total_profiles_created, 0, 100000000, 0),
    total_profiles_updated: clampNumber(m.total_profiles_updated, 0, 100000000, 0),
    total_queue_consumed: clampNumber(m.total_queue_consumed, 0, 100000000, 0),
    total_gc_deleted: clampNumber(m.total_gc_deleted, 0, 100000000, 0),
    last_gc_ts: m.last_gc_ts && Number.isFinite(Date.parse(m.last_gc_ts)) ? String(m.last_gc_ts) : null,
    last_usage_sync_ts: m.last_usage_sync_ts && Number.isFinite(Date.parse(m.last_usage_sync_ts))
      ? String(m.last_usage_sync_ts)
      : null
  };

  return {
    version: String(src.version || base.version),
    policy,
    profiles,
    intake_queue: intakeQueue,
    metrics
  };
}

function asStorePath(filePath) {
  const canonical = STORE_ABS_PATH;
  const raw = String(filePath || '').trim();
  if (!raw) return canonical;
  const requested = path.resolve(raw);
  if (requested !== canonical) {
    throw new Error(`strategy_store: path override denied (requested=${requested})`);
  }
  return canonical;
}

function readStrategyState(filePath, fallback = null) {
  const abs = asStorePath(filePath);
  return normalizeState(readJson(abs, fallback), fallback || defaultStrategyState());
}

function ensureStrategyState(filePath: string, meta: AnyObj = {}): AnyObj {
  const abs = asStorePath(filePath);
  return normalizeState(
    ensureJson(abs, defaultStrategyState, {
      ...meta,
      source: meta.source || 'systems/adaptive/strategy/strategy_store.js',
      reason: meta.reason || 'ensure_strategy_state'
    }),
    defaultStrategyState()
  );
}

function setStrategyState(filePath: string, nextState: AnyObj, meta: AnyObj = {}): AnyObj {
  const abs = asStorePath(filePath);
  const normalized = normalizeState(nextState, defaultStrategyState());
  return normalizeState(
    setJson(abs, normalized, {
      ...meta,
      source: meta.source || 'systems/adaptive/strategy/strategy_store.js',
      reason: meta.reason || 'set_strategy_state'
    }),
    defaultStrategyState()
  );
}

function mutateStrategyState(filePath: string, mutator: (state: AnyObj) => AnyObj, meta: AnyObj = {}): AnyObj {
  const abs = asStorePath(filePath);
  if (typeof mutator !== 'function') throw new Error('strategy_store: mutator must be function');
  return normalizeState(
    mutateJson(
      abs,
      (current) => {
        const base = normalizeState(current, defaultStrategyState());
        const next = mutator({
          ...base,
          policy: { ...(base.policy || {}) },
          profiles: Array.isArray(base.profiles) ? base.profiles.map((p) => ({ ...p })) : [],
          intake_queue: Array.isArray(base.intake_queue) ? base.intake_queue.map((q) => ({ ...q })) : [],
          metrics: { ...(base.metrics || {}) }
        });
        return normalizeState(next, base);
      },
      {
        ...meta,
        source: meta.source || 'systems/adaptive/strategy/strategy_store.js',
        reason: meta.reason || 'mutate_strategy_state'
      }
    ),
    defaultStrategyState()
  );
}

function upsertProfile(filePath: string, profileInput: AnyObj, meta: AnyObj = {}): AnyObj {
  let result = null;
  const next = mutateStrategyState(
    filePath,
    (state) => {
      const ts = nowIso();
      const incoming = validateProfileInput(profileInput, {
        allow_elevated_mode: meta.allow_elevated_mode === true
      });
      const idx = state.profiles.findIndex((p) => String(p.id || '') === String(incoming.id || ''));
      if (idx >= 0) {
        const existing = normalizeProfile(state.profiles[idx], ts);
        const merged = normalizeProfile({
          ...existing,
          ...incoming,
          usage: existing.usage && typeof existing.usage === 'object'
            ? {
              ...existing.usage,
              ...(incoming.usage || {})
            }
            : incoming.usage
        }, ts);
        merged.created_ts = existing.created_ts;
        merged.updated_ts = ts;
        state.profiles[idx] = merged;
        state.metrics.total_profiles_updated = Number(state.metrics.total_profiles_updated || 0) + 1;
        result = { action: 'updated', profile: merged };
      } else {
        const created = normalizeProfile({
          ...incoming,
          created_ts: ts,
          updated_ts: ts
        }, ts);
        state.profiles.push(created);
        state.metrics.total_profiles_created = Number(state.metrics.total_profiles_created || 0) + 1;
        result = { action: 'created', profile: created };
      }
      const max = Number(state.policy.max_profiles || 64);
      if (state.profiles.length > max) {
        state.profiles.sort((a, b) => Date.parse(a.updated_ts || 0) - Date.parse(b.updated_ts || 0));
        state.profiles = state.profiles.slice(-max);
      }
      state.profiles.sort((a, b) => String(a.id || '').localeCompare(String(b.id || '')));
      return state;
    },
    {
      ...meta,
      reason: meta.reason || 'upsert_profile'
    }
  );
  return { state: next, ...(result || { action: 'none', profile: null }) };
}

function intakeSignal(filePath: string, intakeInput: AnyObj, meta: AnyObj = {}): AnyObj {
  let result = null;
  const next = mutateStrategyState(
    filePath,
    (state) => {
      const ts = nowIso();
      const item = normalizeQueueItem({
        ...intakeInput,
        created_ts: ts,
        updated_ts: ts
      }, ts);
      const drops = queueDropReason(item, state.policy, Date.now());
      if (drops.length) {
        item.status = 'dropped';
        item.drop_reason = drops.join(',');
      }
      const duplicate = state.intake_queue.find((q) => String(q.fingerprint || '') === String(item.fingerprint || '') && q.status === 'queued');
      if (duplicate) {
        result = { action: 'deduped', queue_item: duplicate };
        return state;
      }
      state.intake_queue.push(item);
      state.intake_queue.sort((a, b) => Date.parse(a.created_ts || 0) - Date.parse(b.created_ts || 0));
      const max = Number(state.policy.max_queue || 64);
      if (state.intake_queue.length > max) {
        const dropCount = state.intake_queue.length - max;
        state.intake_queue = state.intake_queue.slice(dropCount);
      }
      state.metrics.total_intakes = Number(state.metrics.total_intakes || 0) + 1;
      result = {
        action: item.status === 'dropped' ? 'dropped' : 'queued',
        queue_item: item
      };
      return state;
    },
    {
      ...meta,
      reason: meta.reason || 'intake_signal'
    }
  );
  return { state: next, ...(result || { action: 'none', queue_item: null }) };
}

function materializeFromQueue(filePath: string, queueUid: string, draftInput: AnyObj, meta: AnyObj = {}): AnyObj {
  const qid = String(queueUid || '').trim();
  if (!qid) throw new Error('strategy_store: queue_uid_required');
  let result = null;
  const next = mutateStrategyState(
    filePath,
    (state) => {
      const ts = nowIso();
      const idx = state.intake_queue.findIndex((q) => String(q.uid || '') === qid);
      if (idx < 0) throw new Error(`strategy_store: queue_item_not_found:${qid}`);
      const queueItem = normalizeQueueItem(state.intake_queue[idx], ts);
      if (queueItem.status !== 'queued') {
        throw new Error(`strategy_store: queue_item_not_queued:${qid}`);
      }
      const draftObj = draftInput && typeof draftInput === 'object' ? draftInput : {};
      const upsert = validateProfileInput({
        ...draftObj,
        source: cleanText(draftObj.source || queueItem.source || 'adaptive_intake', 80),
        queue_ref: qid,
        generated_mode: normalizeMode(
          draftObj.generated_mode
          || draftObj.generation_mode
          || queueItem.recommended_generation_mode,
          'hyper-creative'
        ),
        tags: Array.from(new Set([...(Array.isArray(draftObj.tags) ? draftObj.tags : []), 'adaptive', 'strategy'])),
        allow_elevated_mode: meta.allow_elevated_mode === true,
        created_ts: ts,
        updated_ts: ts
      }, {
        allow_elevated_mode: meta.allow_elevated_mode === true
      });

      const existingIdx = state.profiles.findIndex((p) => String(p.id || '') === String(upsert.id || ''));
      let profileAction = 'created';
      if (existingIdx >= 0) {
        const prev = normalizeProfile(state.profiles[existingIdx], ts);
        upsert.created_ts = prev.created_ts;
        upsert.usage = normalizeUsage(prev.usage, ts);
        state.profiles[existingIdx] = upsert;
        profileAction = 'updated';
        state.metrics.total_profiles_updated = Number(state.metrics.total_profiles_updated || 0) + 1;
      } else {
        state.profiles.push(upsert);
        state.metrics.total_profiles_created = Number(state.metrics.total_profiles_created || 0) + 1;
      }

      state.profiles.sort((a, b) => String(a.id || '').localeCompare(String(b.id || '')));
      queueItem.status = 'consumed';
      queueItem.updated_ts = ts;
      queueItem.consumed_ts = ts;
      queueItem.linked_strategy_id = upsert.id;
      queueItem.attempts = Number(queueItem.attempts || 0) + 1;
      queueItem.work_packet = ensureWorkPacket(queueItem);
      state.intake_queue[idx] = queueItem;
      state.metrics.total_queue_consumed = Number(state.metrics.total_queue_consumed || 0) + 1;
      result = {
        action: profileAction,
        profile: upsert,
        queue_item: queueItem
      };
      return state;
    },
    {
      ...meta,
      reason: meta.reason || 'materialize_from_queue'
    }
  );
  return { state: next, ...(result || { action: 'none', profile: null, queue_item: null }) };
}

function touchProfileUsage(filePath: string, strategyId: string, ts: string, meta: AnyObj = {}): AnyObj {
  const sid = normalizeKey(strategyId, 40);
  if (!sid) throw new Error('strategy_store: strategy_id_required');
  const touchTs = ts && Number.isFinite(Date.parse(ts)) ? new Date(ts).toISOString() : nowIso();
  let result = null;
  const next = mutateStrategyState(
    filePath,
    (state) => {
      const idx = state.profiles.findIndex((p) => String(p.id || '') === sid);
      if (idx < 0) throw new Error(`strategy_store: strategy_not_found:${sid}`);
      const profile = normalizeProfile(state.profiles[idx], touchTs);
      const usage = normalizeUsage(profile.usage, touchTs);
      usage.use_events = [...usage.use_events, touchTs].slice(-256);
      usage.uses_total = Number(usage.uses_total || 0) + 1;
      const cutoff = Date.parse(touchTs) - (30 * 24 * 60 * 60 * 1000);
      usage.uses_30d = usage.use_events.filter((x) => Date.parse(x) >= cutoff).length;
      usage.last_used_ts = touchTs;
      usage.last_usage_sync_ts = touchTs;
      profile.usage = usage;
      profile.updated_ts = touchTs;
      state.profiles[idx] = profile;
      result = { profile };
      return state;
    },
    {
      ...meta,
      reason: meta.reason || 'touch_profile_usage'
    }
  );
  return { state: next, ...(result || { profile: null }) };
}

function evaluateGcCandidates(state: AnyObj, opts: AnyObj = {}): AnyObj {
  const policy = state && state.policy && typeof state.policy === 'object' ? state.policy : defaultStrategyState().policy;
  const nowMs = Date.now();
  const inactiveDays = clampNumber(opts.inactive_days, 1, 365, Number(policy.gc_inactive_days || 21));
  const minUses30d = clampNumber(opts.min_uses_30d, 0, 1000, Number(policy.gc_min_uses_30d || 1));
  const protectDays = clampNumber(opts.protect_new_days, 0, 90, Number(policy.gc_protect_new_days || 3));
  const candidates = [];
  const keepers = [];
  const profiles = Array.isArray(state && state.profiles) ? state.profiles : [];
  for (const p of profiles) {
    const profile = normalizeProfile(p, nowIso());
    const usage: AnyObj = profile.usage || {};
    const lastUsed = Number.isFinite(Date.parse(usage.last_used_ts || '')) ? Date.parse(usage.last_used_ts) : 0;
    const created = Number.isFinite(Date.parse(profile.created_ts || '')) ? Date.parse(profile.created_ts) : 0;
    const ageDays = lastUsed > 0 ? (nowMs - lastUsed) / (24 * 60 * 60 * 1000) : Number.POSITIVE_INFINITY;
    const newAgeDays = created > 0 ? (nowMs - created) / (24 * 60 * 60 * 1000) : Number.POSITIVE_INFINITY;
    const uses30 = Number(usage.uses_30d || 0);
    const stale = ageDays > inactiveDays;
    const lowUse = uses30 < minUses30d;
    const protectedNew = newAgeDays < protectDays;
    const removable = stale && lowUse && !protectedNew && String(profile.status || '') !== 'active';
    const row = {
      id: profile.id,
      uid: profile.uid,
      status: profile.status,
      stage: profile.stage,
      age_days_since_last_use: Number.isFinite(ageDays) ? Number(ageDays.toFixed(3)) : null,
      age_days_since_created: Number.isFinite(newAgeDays) ? Number(newAgeDays.toFixed(3)) : null,
      uses_30d: uses30,
      removable,
      reason: removable
        ? `stale>${inactiveDays}d and uses_30d<${minUses30d}`
        : (protectedNew
          ? `protected_new<${protectDays}d`
          : (stale ? `uses_30d>=${minUses30d}` : `last_used<=${inactiveDays}d`))
    };
    if (removable) candidates.push(row);
    else keepers.push(row);
  }
  return {
    policy: {
      inactive_days: inactiveDays,
      min_uses_30d: minUses30d,
      protect_new_days: protectDays
    },
    candidates,
    keepers
  };
}

function gcProfiles(filePath: string, opts: AnyObj = {}, meta: AnyObj = {}): AnyObj {
  const apply = opts && opts.apply === true;
  let gcSummary = null;
  const next = mutateStrategyState(
    filePath,
    (state) => {
      const evals = evaluateGcCandidates(state, opts);
      gcSummary = evals;
      if (!apply || !evals.candidates.length) return state;
      const removeIds = new Set(evals.candidates.map((x) => String(x.id || '')));
      const kept = [];
      for (const p of state.profiles) {
        if (!removeIds.has(String(p.id || ''))) kept.push(p);
      }
      state.profiles = kept;
      state.metrics.total_gc_deleted = Number(state.metrics.total_gc_deleted || 0) + evals.candidates.length;
      state.metrics.last_gc_ts = nowIso();
      return state;
    },
    {
      ...meta,
      reason: meta.reason || (apply ? 'gc_profiles_apply' : 'gc_profiles_preview')
    }
  );
  return {
    state: next,
    apply,
    policy: gcSummary ? gcSummary.policy : null,
    removed: gcSummary ? gcSummary.candidates : [],
    kept: gcSummary ? gcSummary.keepers : []
  };
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

export {};
