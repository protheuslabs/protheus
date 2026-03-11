'use strict';
export {};

const fs = require('fs');
const path = require('path');

type AnyObj = Record<string, any>;

const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_POLICY_PATH = process.env.SYMBIOSIS_COHERENCE_POLICY_PATH
  ? path.resolve(process.env.SYMBIOSIS_COHERENCE_POLICY_PATH)
  : path.join(REPO_ROOT, 'config', 'symbiosis_coherence_policy.json');

function nowIso() {
  return new Date().toISOString();
}

function cleanText(v: unknown, maxLen = 240) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeToken(v: unknown, maxLen = 120) {
  return cleanText(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.:/-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function clampNumber(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function clampInt(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

function toBool(v: unknown, fallback = false) {
  if (v == null) return fallback;
  const raw = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function asFinite(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath: string, fallback: any = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath: string, payload: AnyObj) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${Date.now()}-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function appendJsonl(filePath: string, payload: AnyObj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`, 'utf8');
}

function relPath(filePath: string) {
  return path.relative(REPO_ROOT, filePath).replace(/\\/g, '/');
}

function resolvePath(raw: unknown, fallbackRel: string) {
  const txt = cleanText(raw || fallbackRel, 520);
  if (!txt) return path.join(REPO_ROOT, fallbackRel);
  return path.isAbsolute(txt) ? path.resolve(txt) : path.join(REPO_ROOT, txt);
}

function roundTo(v: unknown, digits = 6) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  const p = Math.pow(10, Math.max(0, Math.min(8, digits)));
  return Math.round(n * p) / p;
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    shadow_only: true,
    stale_after_minutes: 30,
    weights: {
      identity: 0.34,
      pre_neuralink: 0.22,
      behavioral: 0.22,
      mirror: 0.22
    },
    thresholds: {
      low_max: 0.45,
      medium_max: 0.75,
      high_min: 0.75,
      unbounded_min: 0.9,
      sustained_high_samples: 6
    },
    recursion: {
      low_depth: 1,
      medium_depth: 2,
      high_base_depth: 4,
      high_streak_gain_interval: 2,
      require_granted_consent_for_unbounded: true,
      require_identity_clear_for_unbounded: true
    },
    history: {
      max_recent_scores: 200
    },
    paths: {
      state_path: 'state/symbiosis/coherence/state.json',
      latest_path: 'state/symbiosis/coherence/latest.json',
      receipts_path: 'state/symbiosis/coherence/receipts.jsonl',
      identity_latest_path: 'state/autonomy/identity_anchor/latest.json',
      pre_neuralink_state_path: 'state/symbiosis/pre_neuralink_interface/state.json',
      deep_symbiosis_state_path: 'state/symbiosis/deep_understanding/state.json',
      observer_mirror_latest_path: 'state/autonomy/observer_mirror/latest.json'
    }
  };
}

function normalizeWeights(raw: AnyObj, base: AnyObj) {
  const out = {
    identity: clampNumber(raw.identity, 0, 1, base.identity),
    pre_neuralink: clampNumber(raw.pre_neuralink, 0, 1, base.pre_neuralink),
    behavioral: clampNumber(raw.behavioral, 0, 1, base.behavioral),
    mirror: clampNumber(raw.mirror, 0, 1, base.mirror)
  };
  const total = Number(out.identity + out.pre_neuralink + out.behavioral + out.mirror);
  if (total <= 0) return base;
  return {
    identity: roundTo(out.identity / total, 6),
    pre_neuralink: roundTo(out.pre_neuralink / total, 6),
    behavioral: roundTo(out.behavioral / total, 6),
    mirror: roundTo(out.mirror / total, 6)
  };
}

function loadSymbiosisCoherencePolicy(policyPath = DEFAULT_POLICY_PATH) {
  const base = defaultPolicy();
  const raw = readJson(policyPath, {});
  const weights = raw.weights && typeof raw.weights === 'object' ? raw.weights : {};
  const thresholds = raw.thresholds && typeof raw.thresholds === 'object' ? raw.thresholds : {};
  const recursion = raw.recursion && typeof raw.recursion === 'object' ? raw.recursion : {};
  const history = raw.history && typeof raw.history === 'object' ? raw.history : {};
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  return {
    version: cleanText(raw.version || base.version, 32) || base.version,
    enabled: raw.enabled !== false,
    shadow_only: toBool(raw.shadow_only, base.shadow_only),
    stale_after_minutes: clampInt(raw.stale_after_minutes, 1, 24 * 60, base.stale_after_minutes),
    weights: normalizeWeights(weights, base.weights),
    thresholds: {
      low_max: clampNumber(thresholds.low_max, 0.05, 0.95, base.thresholds.low_max),
      medium_max: clampNumber(thresholds.medium_max, 0.1, 0.99, base.thresholds.medium_max),
      high_min: clampNumber(thresholds.high_min, 0.1, 0.99, base.thresholds.high_min),
      unbounded_min: clampNumber(thresholds.unbounded_min, 0.2, 1, base.thresholds.unbounded_min),
      sustained_high_samples: clampInt(
        thresholds.sustained_high_samples,
        1,
        1000,
        base.thresholds.sustained_high_samples
      )
    },
    recursion: {
      low_depth: clampInt(recursion.low_depth, 1, 10_000, base.recursion.low_depth),
      medium_depth: clampInt(recursion.medium_depth, 1, 10_000, base.recursion.medium_depth),
      high_base_depth: clampInt(recursion.high_base_depth, 1, 100_000, base.recursion.high_base_depth),
      high_streak_gain_interval: clampInt(
        recursion.high_streak_gain_interval,
        1,
        10_000,
        base.recursion.high_streak_gain_interval
      ),
      require_granted_consent_for_unbounded: toBool(
        recursion.require_granted_consent_for_unbounded,
        base.recursion.require_granted_consent_for_unbounded
      ),
      require_identity_clear_for_unbounded: toBool(
        recursion.require_identity_clear_for_unbounded,
        base.recursion.require_identity_clear_for_unbounded
      )
    },
    history: {
      max_recent_scores: clampInt(history.max_recent_scores, 10, 10_000, base.history.max_recent_scores)
    },
    paths: {
      state_path: resolvePath(paths.state_path || base.paths.state_path, base.paths.state_path),
      latest_path: resolvePath(paths.latest_path || base.paths.latest_path, base.paths.latest_path),
      receipts_path: resolvePath(paths.receipts_path || base.paths.receipts_path, base.paths.receipts_path),
      identity_latest_path: resolvePath(paths.identity_latest_path || base.paths.identity_latest_path, base.paths.identity_latest_path),
      pre_neuralink_state_path: resolvePath(paths.pre_neuralink_state_path || base.paths.pre_neuralink_state_path, base.paths.pre_neuralink_state_path),
      deep_symbiosis_state_path: resolvePath(paths.deep_symbiosis_state_path || base.paths.deep_symbiosis_state_path, base.paths.deep_symbiosis_state_path),
      observer_mirror_latest_path: resolvePath(paths.observer_mirror_latest_path || base.paths.observer_mirror_latest_path, base.paths.observer_mirror_latest_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function defaultState() {
  return {
    schema_id: 'symbiosis_coherence_state',
    schema_version: '1.0',
    updated_at: null,
    runs: 0,
    recent_scores: []
  };
}

function loadState(policy: AnyObj) {
  const src = readJson(policy.paths.state_path, null);
  const base = defaultState();
  if (!src || typeof src !== 'object') return base;
  return {
    ...base,
    ...src,
    runs: clampInt(src.runs, 0, 1_000_000_000, 0),
    recent_scores: Array.isArray(src.recent_scores)
      ? src.recent_scores
        .map((row: AnyObj) => ({
          ts: cleanText(row && row.ts || '', 60) || null,
          score: clampNumber(row && row.score, 0, 1, 0),
          tier: normalizeToken(row && row.tier || 'low', 24) || 'low'
        }))
        .filter((row: AnyObj) => row.ts)
      : []
  };
}

function saveState(policy: AnyObj, state: AnyObj) {
  writeJsonAtomic(policy.paths.state_path, {
    schema_id: 'symbiosis_coherence_state',
    schema_version: '1.0',
    updated_at: nowIso(),
    runs: clampInt(state && state.runs, 0, 1_000_000_000, 0),
    recent_scores: Array.isArray(state && state.recent_scores)
      ? state.recent_scores.slice(-policy.history.max_recent_scores)
      : []
  });
}

function computeIdentityComponent(policy: AnyObj) {
  const latest = readJson(policy.paths.identity_latest_path, {});
  const summary = latest && latest.summary && typeof latest.summary === 'object'
    ? latest.summary
    : latest;
  const driftScore = clampNumber(
    summary && (summary.identity_drift_score != null ? summary.identity_drift_score : latest.identity_drift_score),
    0,
    1,
    0.5
  );
  const maxDrift = clampNumber(
    summary && (summary.max_identity_drift_score != null ? summary.max_identity_drift_score : latest.max_identity_drift_score),
    0.01,
    1,
    0.58
  );
  const blocked = Math.max(0, Number(summary && summary.blocked || latest.blocked || 0) || 0);
  const checked = Math.max(0, Number(summary && summary.checked || latest.checked || 0) || 0);
  const driftRatio = clampNumber(driftScore / Math.max(0.0001, maxDrift), 0, 1.5, 1);
  const blockedRatio = checked > 0
    ? clampNumber(blocked / checked, 0, 1, 0)
    : 0;
  const score = clampNumber(1 - ((driftRatio * 0.75) + (blockedRatio * 0.25)), 0, 1, 0.3);
  return {
    score: roundTo(score, 6),
    detail: {
      drift_score: roundTo(driftScore, 6),
      max_drift_score: roundTo(maxDrift, 6),
      blocked,
      checked,
      blocked_ratio: roundTo(blockedRatio, 6)
    },
    source_path: relPath(policy.paths.identity_latest_path)
  };
}

function computePreNeuralinkComponent(policy: AnyObj) {
  const state = readJson(policy.paths.pre_neuralink_state_path, {});
  const consentState = normalizeToken(state && state.consent_state || 'paused', 40) || 'paused';
  const consentScore = consentState === 'granted'
    ? 1
    : (consentState === 'paused' ? 0.45 : 0.1);
  const signalsTotal = Math.max(0, Number(state && state.signals_total || 0) || 0);
  const routedTotal = Math.max(0, Number(state && state.routed_total || 0) || 0);
  const blockedTotal = Math.max(0, Number(state && state.blocked_total || 0) || 0);
  const routedRatio = signalsTotal > 0
    ? clampNumber(routedTotal / signalsTotal, 0, 1, 0)
    : (consentState === 'granted' ? 0.7 : 0.4);
  const blockedRatio = signalsTotal > 0
    ? clampNumber(blockedTotal / signalsTotal, 0, 1, 0)
    : 0;
  const score = clampNumber((consentScore * 0.6) + (routedRatio * 0.3) + ((1 - blockedRatio) * 0.1), 0, 1, 0.2);
  return {
    score: roundTo(score, 6),
    detail: {
      consent_state: consentState,
      signals_total: signalsTotal,
      routed_total: routedTotal,
      blocked_total: blockedTotal,
      routed_ratio: roundTo(routedRatio, 6),
      blocked_ratio: roundTo(blockedRatio, 6)
    },
    source_path: relPath(policy.paths.pre_neuralink_state_path)
  };
}

function computeBehavioralComponent(policy: AnyObj) {
  const state = readJson(policy.paths.deep_symbiosis_state_path, {});
  const samples = Math.max(0, Number(state && state.samples || 0) || 0);
  const style = state && state.style && typeof state.style === 'object' ? state.style : {};
  const directness = clampNumber(style.directness, 0, 1, 0.75);
  const brevity = clampNumber(style.brevity, 0, 1, 0.7);
  const proactive = clampNumber(style.proactive_delta, 0, 1, 0.65);
  const sampleScore = clampNumber(samples / 50, 0, 1, 0);
  const styleScore = clampNumber((directness + brevity + proactive) / 3, 0, 1, 0.7);
  const score = clampNumber((sampleScore * 0.45) + (styleScore * 0.55), 0, 1, 0.2);
  return {
    score: roundTo(score, 6),
    detail: {
      samples,
      sample_score: roundTo(sampleScore, 6),
      style: {
        directness: roundTo(directness, 6),
        brevity: roundTo(brevity, 6),
        proactive_delta: roundTo(proactive, 6)
      },
      style_score: roundTo(styleScore, 6)
    },
    source_path: relPath(policy.paths.deep_symbiosis_state_path)
  };
}

function computeMirrorComponent(policy: AnyObj) {
  const latest = readJson(policy.paths.observer_mirror_latest_path, {});
  const mood = normalizeToken(
    latest && latest.observer && latest.observer.mood != null
      ? latest.observer.mood
      : latest.mood,
    40
  ) || 'unknown';
  const moodScore = mood === 'stable'
    ? 1
    : (mood === 'guarded' ? 0.7 : (mood === 'strained' ? 0.35 : 0.6));
  const rates = latest && latest.summary && latest.summary.rates && typeof latest.summary.rates === 'object'
    ? latest.summary.rates
    : {};
  const shipRate = clampNumber(rates.ship_rate, 0, 1, 0.5);
  const holdRate = clampNumber(rates.hold_rate, 0, 1, 0.3);
  const score = clampNumber((moodScore * 0.5) + (shipRate * 0.35) + ((1 - holdRate) * 0.15), 0, 1, 0.2);
  return {
    score: roundTo(score, 6),
    detail: {
      mood,
      mood_score: roundTo(moodScore, 6),
      ship_rate: roundTo(shipRate, 6),
      hold_rate: roundTo(holdRate, 6)
    },
    source_path: relPath(policy.paths.observer_mirror_latest_path)
  };
}

function scoreTier(policy: AnyObj, score: number): 'low' | 'medium' | 'high' {
  if (score < Number(policy.thresholds.low_max || 0.45)) return 'low';
  if (score < Number(policy.thresholds.medium_max || 0.75)) return 'medium';
  return 'high';
}

function countConsecutiveHigh(rows: AnyObj[], highMin: number) {
  let streak = 0;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    const score = clampNumber(row && row.score, 0, 1, 0);
    if (score >= highMin) streak += 1;
    else break;
  }
  return streak;
}

function computeAllowedDepth(policy: AnyObj, score: number, tier: string, sustainedHighSamples: number) {
  if (tier === 'low') return clampInt(policy.recursion.low_depth, 1, 1_000_000, 1);
  if (tier === 'medium') {
    const low = Number(policy.thresholds.low_max || 0.45);
    const medium = Number(policy.thresholds.medium_max || 0.75);
    const denom = Math.max(0.0001, medium - low);
    const progress = clampNumber((score - low) / denom, 0, 1, 0);
    const extra = progress >= 0.5 ? 1 : 0;
    return clampInt(Number(policy.recursion.medium_depth || 2) + extra, 1, 1_000_000, 2);
  }
  const base = clampInt(policy.recursion.high_base_depth, 1, 1_000_000, 4);
  const gainInterval = clampInt(policy.recursion.high_streak_gain_interval, 1, 1_000_000, 2);
  const streakGain = Math.max(0, Math.floor(Math.max(0, sustainedHighSamples - 1) / gainInterval));
  return base + streakGain;
}

function isFresh(ts: unknown, staleAfterMinutes: number) {
  const t = Date.parse(String(ts || ''));
  if (!Number.isFinite(t)) return false;
  const ageMs = Date.now() - t;
  return ageMs <= Math.max(1, staleAfterMinutes) * 60 * 1000;
}

function evaluateSymbiosisCoherenceSignal(opts: AnyObj = {}) {
  const policy = opts.policy && typeof opts.policy === 'object'
    ? opts.policy
    : loadSymbiosisCoherencePolicy(opts.policy_path || opts.policyPath || DEFAULT_POLICY_PATH);

  if (policy.enabled !== true) {
    return {
      available: false,
      type: 'symbiosis_coherence_signal',
      ts: nowIso(),
      policy_path: relPath(policy.policy_path),
      reason: 'policy_disabled',
      shadow_only: true
    };
  }

  const identity = computeIdentityComponent(policy);
  const preNeuralink = computePreNeuralinkComponent(policy);
  const behavioral = computeBehavioralComponent(policy);
  const mirror = computeMirrorComponent(policy);

  const score = clampNumber(
    (identity.score * policy.weights.identity)
      + (preNeuralink.score * policy.weights.pre_neuralink)
      + (behavioral.score * policy.weights.behavioral)
      + (mirror.score * policy.weights.mirror),
    0,
    1,
    0
  );
  const roundedScore = roundTo(score, 6);
  const tier = scoreTier(policy, roundedScore);

  const state = loadState(policy);
  const nextRecent = state.recent_scores.concat([{
    ts: nowIso(),
    score: roundedScore,
    tier
  }]).slice(-policy.history.max_recent_scores);
  const sustainedHighSamples = countConsecutiveHigh(nextRecent, Number(policy.thresholds.high_min || 0.75));

  const unboundedAllowedBase = roundedScore >= Number(policy.thresholds.unbounded_min || 0.9)
    && sustainedHighSamples >= Number(policy.thresholds.sustained_high_samples || 6);
  const consentGranted = String(preNeuralink.detail && preNeuralink.detail.consent_state || '') === 'granted';
  const identityClear = Number(identity.detail && identity.detail.blocked || 0) <= 0;
  const unboundedAllowed = unboundedAllowedBase
    && (!policy.recursion.require_granted_consent_for_unbounded || consentGranted)
    && (!policy.recursion.require_identity_clear_for_unbounded || identityClear);

  const allowedDepth = unboundedAllowed
    ? null
    : computeAllowedDepth(policy, roundedScore, tier, sustainedHighSamples);

  const payload = {
    ok: true,
    available: true,
    type: 'symbiosis_coherence_signal',
    ts: nowIso(),
    policy_version: policy.version,
    policy_path: relPath(policy.policy_path),
    shadow_only: policy.shadow_only === true,
    coherence_score: roundedScore,
    coherence_tier: tier,
    component_scores: {
      identity: identity.score,
      pre_neuralink: preNeuralink.score,
      behavioral: behavioral.score,
      mirror: mirror.score
    },
    components: {
      identity: identity.detail,
      pre_neuralink: preNeuralink.detail,
      behavioral: behavioral.detail,
      mirror_feedback: mirror.detail
    },
    recursion_gate: {
      allowed_depth: allowedDepth,
      unbounded_allowed: unboundedAllowed,
      sustained_high_samples: sustainedHighSamples,
      required_sustained_high_samples: Number(policy.thresholds.sustained_high_samples || 6),
      high_min_score: Number(policy.thresholds.high_min || 0.75),
      unbounded_min_score: Number(policy.thresholds.unbounded_min || 0.9)
    },
    source_paths: {
      identity_latest_path: identity.source_path,
      pre_neuralink_state_path: preNeuralink.source_path,
      deep_symbiosis_state_path: behavioral.source_path,
      observer_mirror_latest_path: mirror.source_path,
      latest_path: relPath(policy.paths.latest_path)
    }
  };

  if (opts.persist !== false) {
    state.runs = clampInt(Number(state.runs || 0) + 1, 0, 1_000_000_000, 0);
    state.recent_scores = nextRecent;
    saveState(policy, state);
    writeJsonAtomic(policy.paths.latest_path, payload);
    appendJsonl(policy.paths.receipts_path, payload);
  }

  return payload;
}

function loadSymbiosisCoherenceSignal(opts: AnyObj = {}) {
  const policy = opts.policy && typeof opts.policy === 'object'
    ? opts.policy
    : loadSymbiosisCoherencePolicy(opts.policy_path || opts.policyPath || DEFAULT_POLICY_PATH);
  const refresh = opts.refresh === true;
  if (!refresh) {
    const latest = readJson(policy.paths.latest_path, null);
    if (latest && typeof latest === 'object' && latest.available === true) {
      if (isFresh(latest.ts, policy.stale_after_minutes)) {
        return {
          ...latest,
          latest_path: policy.paths.latest_path,
          latest_path_rel: relPath(policy.paths.latest_path)
        };
      }
    }
  }
  const evaluated = evaluateSymbiosisCoherenceSignal({
    policy,
    persist: opts.persist !== false
  });
  return {
    ...evaluated,
    latest_path: policy.paths.latest_path,
    latest_path_rel: relPath(policy.paths.latest_path)
  };
}

function parseDepthRequest(raw: unknown) {
  if (raw == null) return { depth: 1, unbounded: false };
  const token = normalizeToken(raw, 40);
  if (['unbounded', 'infinite', 'max', 'none'].includes(token)) {
    return { depth: null, unbounded: true };
  }
  const n = Number(raw);
  if (Number.isFinite(n)) {
    return {
      depth: clampInt(n, 1, 1_000_000_000, 1),
      unbounded: false
    };
  }
  return { depth: 1, unbounded: false };
}

function evaluateRecursionRequest(opts: AnyObj = {}) {
  const signal = opts.signal && typeof opts.signal === 'object'
    ? opts.signal
    : loadSymbiosisCoherenceSignal({
      policy_path: opts.policy_path || opts.policyPath,
      refresh: opts.refresh === true,
      persist: opts.persist !== false
    });

  const parsed = parseDepthRequest(opts.requested_depth != null ? opts.requested_depth : opts.requestedDepth);
  const requireUnbounded = toBool(opts.require_unbounded, false) || parsed.unbounded === true;
  const requestedDepth = parsed.depth;
  const allowedDepth = signal
    && signal.recursion_gate
    && signal.recursion_gate.allowed_depth != null
    ? Number(signal.recursion_gate.allowed_depth)
    : null;
  const unboundedAllowed = !!(
    signal
    && signal.recursion_gate
    && signal.recursion_gate.unbounded_allowed === true
  );

  const reasons: string[] = [];
  let blocked = false;
  if (signal.available !== true) {
    reasons.push('symbiosis_signal_unavailable');
  } else {
    if (requireUnbounded && !unboundedAllowed) {
      blocked = true;
      reasons.push('symbiosis_unbounded_not_allowed');
    }
    if (
      requestedDepth != null
      && Number.isFinite(requestedDepth)
      && allowedDepth != null
      && Number.isFinite(allowedDepth)
      && requestedDepth > allowedDepth
    ) {
      blocked = true;
      reasons.push('symbiosis_depth_exceeds_allowed');
    }
  }

  const shadowOnly = opts.shadow_only_override != null
    ? toBool(opts.shadow_only_override, true)
    : signal.shadow_only === true;
  const blockedHard = blocked && !shadowOnly;

  return {
    ok: !blockedHard,
    available: signal.available === true,
    blocked,
    blocked_hard: blockedHard,
    shadow_violation: blocked && shadowOnly,
    shadow_only: shadowOnly,
    reason_codes: reasons,
    requested_depth: requestedDepth,
    requested_unbounded: requireUnbounded,
    allowed_depth: allowedDepth,
    unbounded_allowed: unboundedAllowed,
    coherence_score: signal.coherence_score != null ? Number(signal.coherence_score) : null,
    coherence_tier: signal.coherence_tier || null,
    sustained_high_samples: signal
      && signal.recursion_gate
      && signal.recursion_gate.sustained_high_samples != null
      ? Number(signal.recursion_gate.sustained_high_samples)
      : null,
    latest_path_rel: signal.latest_path_rel || null
  };
}

module.exports = {
  DEFAULT_POLICY_PATH,
  loadSymbiosisCoherencePolicy,
  evaluateSymbiosisCoherenceSignal,
  loadSymbiosisCoherenceSignal,
  evaluateRecursionRequest
};
