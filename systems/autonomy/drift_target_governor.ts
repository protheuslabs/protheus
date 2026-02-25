#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { evaluateTernaryBelief } = require('../../lib/ternary_belief_engine');
const {
  loadTritShadowPolicy,
  loadTritShadowTrustState,
  buildTritSourceTrustMap,
  resolveTritShadowStageDecision,
  resolveTritShadowStage,
  canConsumeTritShadowOverride,
  consumeTritShadowOverride,
  loadTritShadowInfluenceGuard,
  isTritShadowInfluenceBlocked
} = require('../../lib/trit_shadow_control');

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = process.env.AUTONOMY_DRIFT_TARGET_POLICY_PATH
  ? path.resolve(process.env.AUTONOMY_DRIFT_TARGET_POLICY_PATH)
  : path.join(ROOT, 'config', 'drift_target_governor_policy.json');
const DEFAULT_STATE_PATH = process.env.AUTONOMY_DRIFT_TARGET_STATE_PATH
  ? path.resolve(process.env.AUTONOMY_DRIFT_TARGET_STATE_PATH)
  : path.join(ROOT, 'state', 'autonomy', 'drift_target_governor_state.json');
const DEFAULT_HEALTH_REPORTS_DIR = process.env.AUTONOMY_DRIFT_TARGET_HEALTH_REPORTS_DIR
  ? path.resolve(process.env.AUTONOMY_DRIFT_TARGET_HEALTH_REPORTS_DIR)
  : path.join(ROOT, 'state', 'autonomy', 'health_reports');
const DRIFT_TRIT_SHADOW_ENABLED = String(process.env.AUTONOMY_DRIFT_TARGET_TRIT_SHADOW_ENABLED || '1') !== '0';

function clampNumber(v, lo, hi, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function normalizeText(v) {
  return String(v == null ? '' : v).trim();
}

function nowIso() {
  return new Date().toISOString();
}

function todayStr() {
  return nowIso().slice(0, 10);
}

function isDateStr(v) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
}

function resolveDateArg(args) {
  const first = normalizeText(args && args._ && args._[1]);
  if (isDateStr(first)) return first;
  const second = normalizeText(args && args._ && args._[0]);
  if (isDateStr(second)) return second;
  return todayStr();
}

function parseArgs(argv) {
  const out = { _: [] };
  for (const arg of argv) {
    if (!String(arg || '').startsWith('--')) {
      out._.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq === -1) out[arg.slice(2)] = true;
    else out[arg.slice(2, eq)] = arg.slice(eq + 1);
  }
  return out;
}

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    metric: {
      key: 'error_rate_recent',
      fallback_keys: [
        'spc_stop_ratio',
        'simulation_drift_rate'
      ],
      initial_target_rate: 0.03,
      floor_target_rate: 0.005,
      ceiling_target_rate: 0.12
    },
    ratchet: {
      tighten_step_rate: 0.0015,
      loosen_step_rate: 0.0025,
      good_window_streak_required: 2,
      bad_window_streak_required: 1,
      min_windows_between_adjustments: 1,
      history_limit: 180
    },
    guards: {
      min_samples: 6,
      min_verified_rate: 0.6,
      min_shipped_rate: 0.2
    }
  };
}

function normalizePolicy(input) {
  const src = input && typeof input === 'object' ? input : {};
  const base = defaultPolicy();
  const metricSrc = src.metric && typeof src.metric === 'object' ? src.metric : {};
  const ratchetSrc = src.ratchet && typeof src.ratchet === 'object' ? src.ratchet : {};
  const guardsSrc = src.guards && typeof src.guards === 'object' ? src.guards : {};
  return {
    version: normalizeText(src.version) || '1.0',
    enabled: src.enabled !== false,
    metric: {
      key: normalizeText(metricSrc.key) || base.metric.key,
      fallback_keys: Array.from(new Set(
        (Array.isArray(metricSrc.fallback_keys) ? metricSrc.fallback_keys : base.metric.fallback_keys)
          .map(normalizeText)
          .filter(Boolean)
      )),
      initial_target_rate: clampNumber(metricSrc.initial_target_rate, 0.001, 0.9, base.metric.initial_target_rate),
      floor_target_rate: clampNumber(metricSrc.floor_target_rate, 0.001, 0.9, base.metric.floor_target_rate),
      ceiling_target_rate: clampNumber(metricSrc.ceiling_target_rate, 0.001, 0.95, base.metric.ceiling_target_rate)
    },
    ratchet: {
      tighten_step_rate: clampNumber(ratchetSrc.tighten_step_rate, 0.0001, 0.2, base.ratchet.tighten_step_rate),
      loosen_step_rate: clampNumber(ratchetSrc.loosen_step_rate, 0.0001, 0.2, base.ratchet.loosen_step_rate),
      good_window_streak_required: Math.max(1, Math.round(clampNumber(
        ratchetSrc.good_window_streak_required,
        1,
        30,
        base.ratchet.good_window_streak_required
      ))),
      bad_window_streak_required: Math.max(1, Math.round(clampNumber(
        ratchetSrc.bad_window_streak_required,
        1,
        30,
        base.ratchet.bad_window_streak_required
      ))),
      min_windows_between_adjustments: Math.max(0, Math.round(clampNumber(
        ratchetSrc.min_windows_between_adjustments,
        0,
        30,
        base.ratchet.min_windows_between_adjustments
      ))),
      history_limit: Math.max(10, Math.round(clampNumber(
        ratchetSrc.history_limit,
        10,
        1000,
        base.ratchet.history_limit
      )))
    },
    guards: {
      min_samples: Math.max(0, Math.round(clampNumber(guardsSrc.min_samples, 0, 10000, base.guards.min_samples))),
      min_verified_rate: clampNumber(guardsSrc.min_verified_rate, 0, 1, base.guards.min_verified_rate),
      min_shipped_rate: clampNumber(guardsSrc.min_shipped_rate, 0, 1, base.guards.min_shipped_rate)
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  return normalizePolicy(readJson(policyPath, null));
}

function normalizeRate(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return clampNumber(n, 0, 1, null);
}

function pickFirstRate(...values) {
  for (const v of values) {
    const rate = normalizeRate(v);
    if (rate != null) return rate;
  }
  return null;
}

function pickDriftRate(metrics, policy) {
  const keys = [policy.metric.key].concat(policy.metric.fallback_keys || []);
  for (const key of keys) {
    const rate = normalizeRate(metrics && metrics[key]);
    if (rate != null) {
      return {
        key,
        value: rate
      };
    }
  }
  return {
    key: null,
    value: null
  };
}

function defaultState(policy) {
  const floor = Number(policy.metric.floor_target_rate);
  const ceiling = Number(policy.metric.ceiling_target_rate);
  const initial = clampNumber(policy.metric.initial_target_rate, floor, ceiling, policy.metric.initial_target_rate);
  return {
    schema_id: 'drift_target_governor_state',
    schema_version: '1.0.0',
    current_target_rate: Number(initial.toFixed(6)),
    floor_target_rate: Number(floor.toFixed(6)),
    ceiling_target_rate: Number(ceiling.toFixed(6)),
    good_window_streak: 0,
    bad_window_streak: 0,
    windows_seen: 0,
    adjustments_count: 0,
    last_window_date: null,
    last_adjustment_date: null,
    last_decision: null,
    history: [],
    updated_at: null
  };
}

function normalizeState(input, policy) {
  const base = defaultState(policy);
  const src = input && typeof input === 'object' ? input : {};
  const floor = Number(policy.metric.floor_target_rate);
  const ceiling = Number(policy.metric.ceiling_target_rate);
  const currentTarget = clampNumber(src.current_target_rate, floor, ceiling, base.current_target_rate);
  const history = Array.isArray(src.history)
    ? src.history.filter((row) => row && typeof row === 'object').slice(-policy.ratchet.history_limit)
    : [];
  return {
    ...base,
    ...src,
    current_target_rate: Number(currentTarget.toFixed(6)),
    floor_target_rate: Number(floor.toFixed(6)),
    ceiling_target_rate: Number(ceiling.toFixed(6)),
    good_window_streak: Math.max(0, Math.round(clampNumber(src.good_window_streak, 0, 1000, 0))),
    bad_window_streak: Math.max(0, Math.round(clampNumber(src.bad_window_streak, 0, 1000, 0))),
    windows_seen: Math.max(0, Math.round(clampNumber(src.windows_seen, 0, 1000000, 0))),
    adjustments_count: Math.max(0, Math.round(clampNumber(src.adjustments_count, 0, 1000000, 0))),
    last_window_date: isDateStr(src.last_window_date) ? String(src.last_window_date) : null,
    last_adjustment_date: isDateStr(src.last_adjustment_date) ? String(src.last_adjustment_date) : null,
    history
  };
}

function loadState(policy, statePath = DEFAULT_STATE_PATH) {
  return normalizeState(readJson(statePath, null), policy);
}

function dateDiffDays(aDate, bDate) {
  if (!isDateStr(aDate) || !isDateStr(bDate)) return null;
  const a = Date.parse(`${aDate}T00:00:00.000Z`);
  const b = Date.parse(`${bDate}T00:00:00.000Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.floor((a - b) / (24 * 3600 * 1000));
}

function deriveMetricsFromHealthPayload(payload) {
  const obj = payload && typeof payload === 'object' ? payload : {};
  const autonomy = obj.autonomy && typeof obj.autonomy === 'object' ? obj.autonomy : {};
  const tier1 = autonomy.tier1_governance && typeof autonomy.tier1_governance === 'object'
    ? autonomy.tier1_governance
    : {};
  const drift = tier1.drift && typeof tier1.drift === 'object' ? tier1.drift : {};
  const driftMetrics = drift.metrics && typeof drift.metrics === 'object' ? drift.metrics : {};
  const receiptsRoot = obj.autonomy_receipts && typeof obj.autonomy_receipts === 'object'
    ? obj.autonomy_receipts
    : {};
  const receipts = receiptsRoot.receipts && typeof receiptsRoot.receipts === 'object'
    ? receiptsRoot.receipts
    : {};
  const runs = receiptsRoot.runs && typeof receiptsRoot.runs === 'object'
    ? receiptsRoot.runs
    : {};
  const combined = receipts.combined && typeof receipts.combined === 'object'
    ? receipts.combined
    : {};
  const checks = obj.slo && obj.slo.checks && typeof obj.slo.checks === 'object' ? obj.slo.checks : {};
  const driftCheck = checks.drift && typeof checks.drift === 'object' ? checks.drift : {};
  const driftCheckMetrics = driftCheck.metrics && typeof driftCheck.metrics === 'object' ? driftCheck.metrics : {};
  const pipelineSpc = obj.pipeline_spc && typeof obj.pipeline_spc === 'object' ? obj.pipeline_spc : {};
  const pipelineCurrent = pipelineSpc.current && typeof pipelineSpc.current === 'object'
    ? pipelineSpc.current
    : {};
  const simulationDriftRate = obj.autonomy_simulation
    && obj.autonomy_simulation.checks
    && obj.autonomy_simulation.checks.drift_rate
    ? normalizeRate(obj.autonomy_simulation.checks.drift_rate.value)
    : null;
  const attemptedRaw = Number(combined.attempted || pipelineCurrent.attempted || combined.total || 0);
  const attempted = Number.isFinite(attemptedRaw) ? attemptedRaw : 0;
  const spcStopRatio = pickFirstRate(
    driftCheckMetrics.stop_ratio,
    pipelineCurrent.stop_ratio,
    runs.stop_ratio_quality,
    runs.stop_ratio
  );
  const verifiedRate = pickFirstRate(combined.verified_rate);
  const shippedRate = pickFirstRate(
    autonomy
    && autonomy.calibration
    && autonomy.calibration.metrics
    && autonomy.calibration.metrics.shipped_rate,
    combined.shipped_rate
  );
  return {
    error_rate_recent: normalizeRate(driftMetrics.error_rate_recent),
    spc_stop_ratio: spcStopRatio,
    simulation_drift_rate: simulationDriftRate,
    verified_rate: verifiedRate,
    shipped_rate: shippedRate,
    attempted
  };
}

function deriveMetricsFromHealthReport(dateStr, opts = {}) {
  const reportsDir = opts.healthReportsDir || DEFAULT_HEALTH_REPORTS_DIR;
  const fp = path.join(reportsDir, `${dateStr}.daily.json`);
  const report = readJson(fp, null);
  const metrics = deriveMetricsFromHealthPayload(report || {});
  return {
    report_path: fp,
    metrics
  };
}

function driftTritShadowDecision(metrics, target, policy, state, context = {}, tritCtx = {}) {
  if (!DRIFT_TRIT_SHADOW_ENABLED) return null;
  const src = metrics && typeof metrics === 'object' ? metrics : {};
  const driftRate = src.drift_rate != null ? normalizeRate(src.drift_rate) : normalizeRate(src.error_rate_recent);
  const enoughSamples = context.enough_samples === true;
  const verifiedPass = context.verified_pass !== false;
  const shippedPass = context.shipped_pass !== false;
  const guardHealthy = verifiedPass && shippedPass;
  const adjustmentCooldownMet = context.adjustment_cooldown_met !== false;
  const goodWindowStreak = Math.max(0, Number(context.good_window_streak || 0));
  const badWindowStreak = Math.max(0, Number(context.bad_window_streak || 0));
  const goodWindow = context.good_window === true;
  const badWindow = context.bad_window === true;

  const signals = [
    {
      source: 'drift_vs_target',
      trit: driftRate == null ? 0 : (driftRate <= Number(target || 0) ? 1 : -1),
      weight: 4.5
    },
    { source: 'sample_floor', trit: enoughSamples ? 1 : -1, weight: 1.1 },
    {
      source: 'window_classification',
      trit: goodWindow ? 1 : (badWindow ? -1 : 0),
      weight: 1.8
    },
    { source: 'verified_guard', trit: verifiedPass ? 1 : -1, weight: 1.1 },
    { source: 'shipped_guard', trit: shippedPass ? 1 : -1, weight: 1.1 },
    { source: 'cooldown_gate', trit: adjustmentCooldownMet ? 1 : 0, weight: 0.9 },
    {
      source: 'streak_bias',
      trit: goodWindowStreak > badWindowStreak ? 1 : (badWindowStreak > goodWindowStreak ? -1 : 0),
      weight: 0.8
    },
    {
      source: 'recent_adjustment',
      trit: context.adjusted_this_window === true ? -1 : 1,
      weight: 0.5
    }
  ];
  const tritPolicy = tritCtx && tritCtx.trit_policy && typeof tritCtx.trit_policy === 'object'
    ? tritCtx.trit_policy
    : null;
  const trust = tritPolicy && tritPolicy.trust && typeof tritPolicy.trust === 'object'
    ? tritPolicy.trust
    : {};
  const semantics = tritPolicy && tritPolicy.semantics && typeof tritPolicy.semantics === 'object'
    ? tritPolicy.semantics
    : {};
  const belief = evaluateTernaryBelief(signals, {
    label: 'drift_target_governor_shadow',
    positive_threshold: 0.15,
    negative_threshold: -0.15,
    evidence_saturation_count: 5,
    source_trust: tritCtx && tritCtx.source_trust ? tritCtx.source_trust : null,
    source_trust_floor: trust.source_trust_floor,
    source_trust_ceiling: trust.source_trust_ceiling,
    freshness_half_life_hours: trust.freshness_half_life_hours,
    min_non_neutral_signals: semantics.min_non_neutral_signals,
    min_non_neutral_weight: semantics.min_non_neutral_weight,
    min_confidence_for_non_neutral: semantics.min_confidence_for_non_neutral,
    force_neutral_on_insufficient_evidence: semantics.neutral_on_missing !== false
  });

  const goodRequired = Math.max(1, Number(policy && policy.ratchet && policy.ratchet.good_window_streak_required || 1));
  const badRequired = Math.max(1, Number(policy && policy.ratchet && policy.ratchet.bad_window_streak_required || 1));
  let action = 'hold';
  let reason = 'shadow_hold';
  if (
    Number(belief.trit || 0) === 1
    && guardHealthy
    && enoughSamples
    && adjustmentCooldownMet
    && (goodWindow || goodWindowStreak >= goodRequired)
  ) {
    action = 'tighten';
    reason = 'shadow_good_window';
  } else if (
    Number(belief.trit || 0) === -1
    && enoughSamples
    && adjustmentCooldownMet
    && (badWindow || badWindowStreak >= badRequired)
  ) {
    action = 'loosen';
    reason = !guardHealthy ? 'shadow_guard_degraded' : 'shadow_bad_window';
  }

  return {
    enabled: true,
    action,
    reason,
    target: Number(Number(target || 0).toFixed(6)),
    drift_rate: driftRate == null ? null : Number(driftRate.toFixed(6)),
    guard_healthy: guardHealthy,
    enough_samples: enoughSamples,
    adjustment_cooldown_met: adjustmentCooldownMet,
    belief: {
      trit: Number(belief.trit || 0),
      label: String(belief.trit_label || 'unknown'),
      score: Number(Number(belief.score || 0).toFixed(4)),
      confidence: Number(Number(belief.confidence || 0).toFixed(4)),
      evidence_count: Number(belief.evidence_count || 0)
    },
    evidence_guard: belief && belief.evidence_guard && typeof belief.evidence_guard === 'object'
      ? belief.evidence_guard
      : null,
    top_sources: Array.isArray(belief.top_sources) ? belief.top_sources.slice(0, 5) : []
  };
}

function driftTritShadowInfluenceDecision(currentAction, tritShadow, context, tritPolicy, stage, guardState, dateStr) {
  const shadow = tritShadow && typeof tritShadow === 'object' ? tritShadow : null;
  if (!shadow || shadow.enabled !== true) {
    return { enabled: false, stage, apply: false, reason: 'shadow_unavailable' };
  }
  const targetAction = String(shadow.action || 'hold');
  if (!targetAction || targetAction === 'hold') {
    return { enabled: true, stage, apply: false, reason: 'shadow_hold' };
  }
  if (stage < 2) {
    return { enabled: true, stage, apply: false, reason: 'stage_shadow_only' };
  }

  const block = isTritShadowInfluenceBlocked(guardState || {});
  if (block.blocked) {
    return { enabled: true, stage, apply: false, reason: `guard_blocked:${block.reason}`, guard: block };
  }

  const confidence = Number(shadow && shadow.belief && shadow.belief.confidence || 0);
  const confMin = stage >= 3
    ? Number(tritPolicy && tritPolicy.influence && tritPolicy.influence.min_confidence_stage3 || 0.85)
    : Number(tritPolicy && tritPolicy.influence && tritPolicy.influence.min_confidence_stage2 || 0.78);
  if (confidence < confMin) {
    return {
      enabled: true,
      stage,
      apply: false,
      reason: 'confidence_below_stage_min',
      confidence: Number(confidence.toFixed(4)),
      min_confidence: Number(confMin.toFixed(4))
    };
  }

  const ctx = context && typeof context === 'object' ? context : {};
  if (ctx.enough_samples !== true) return { enabled: true, stage, apply: false, reason: 'sample_floor_not_met' };
  if (ctx.adjustment_cooldown_met === false) return { enabled: true, stage, apply: false, reason: 'adjustment_cooldown_active' };
  if (ctx.verified_pass === false) return { enabled: true, stage, apply: false, reason: 'verified_guard_failed' };
  if (ctx.shipped_pass === false) return { enabled: true, stage, apply: false, reason: 'shipped_guard_failed' };

  const action = String(currentAction || 'hold');
  if (action === targetAction) {
    return { enabled: true, stage, apply: false, reason: 'already_matches_legacy', action: targetAction };
  }

  const override = action !== 'hold' && action !== targetAction;
  if (override && stage < 3) {
    return { enabled: true, stage, apply: false, reason: 'stage2_no_override', action: targetAction };
  }
  if (override) {
    const budget = canConsumeTritShadowOverride(tritPolicy, dateStr);
    if (!budget.allowed) {
      return { enabled: true, stage, apply: false, reason: budget.reason || 'override_budget_denied', action: targetAction, budget };
    }
    return {
      enabled: true,
      stage,
      apply: true,
      action: targetAction,
      reason: 'budgeted_shadow_override',
      override: true,
      budget
    };
  }
  return {
    enabled: true,
    stage,
    apply: true,
    action: targetAction,
    reason: 'shadow_fill_gap',
    override: false
  };
}

function evaluateWindow(input, opts = {}) {
  const policy = normalizePolicy(opts.policy || loadPolicy(opts.policyPath || DEFAULT_POLICY_PATH));
  const tritPolicy = loadTritShadowPolicy();
  const tritTrustState = loadTritShadowTrustState(tritPolicy);
  const tritSourceTrust = buildTritSourceTrustMap(tritTrustState);
  const tritStageDecision = resolveTritShadowStageDecision(tritPolicy);
  const tritStage = Number(tritStageDecision && tritStageDecision.stage || resolveTritShadowStage(tritPolicy));
  const tritGuardState = loadTritShadowInfluenceGuard();
  const statePath = opts.statePath || DEFAULT_STATE_PATH;
  const state = loadState(policy, statePath);
  const dateStr = isDateStr(opts.dateStr) ? opts.dateStr : todayStr();
  const allowRepeatedDate = opts.allowRepeatedDate === true;
  if (!allowRepeatedDate && state.last_window_date === dateStr && state.last_decision && typeof state.last_decision === 'object') {
    return {
      ok: true,
      replay: true,
      ts: nowIso(),
      policy,
      state,
      decision: state.last_decision,
      metrics: {},
      source: 'replay',
      state_path: statePath
    };
  }
  const src = input && typeof input === 'object' ? input : {};
  const source = String(src.source || 'manual').trim() || 'manual';
  const metrics = {
    error_rate_recent: normalizeRate(src.error_rate_recent),
    spc_stop_ratio: normalizeRate(src.spc_stop_ratio),
    simulation_drift_rate: normalizeRate(src.simulation_drift_rate),
    verified_rate: normalizeRate(src.verified_rate),
    shipped_rate: normalizeRate(src.shipped_rate),
    attempted: Math.max(0, Math.round(Number(src.attempted || 0)))
  };
  const driftPick = pickDriftRate(metrics, policy);
  const driftRate = driftPick.value;
  const target = Number(state.current_target_rate || policy.metric.initial_target_rate);
  const minSamples = Number(policy.guards.min_samples || 0);
  const enoughSamples = Number(metrics.attempted || 0) >= minSamples;
  const verifiedPass = metrics.verified_rate == null || metrics.verified_rate >= Number(policy.guards.min_verified_rate || 0);
  const shippedPass = metrics.shipped_rate == null || metrics.shipped_rate >= Number(policy.guards.min_shipped_rate || 0);
  const driftPass = driftRate != null && driftRate <= target;
  const driftFail = driftRate != null && driftRate > target;
  const guardHealthy = verifiedPass && shippedPass;

  let action = 'hold';
  let reason = 'insufficient_signal';
  let goodWindow = false;
  let badWindow = false;

  if (driftRate == null || !enoughSamples) {
    reason = driftRate == null ? 'drift_metric_unavailable' : 'sample_floor_not_met';
  } else if (driftPass && guardHealthy) {
    goodWindow = true;
    reason = 'good_window';
  } else if (driftFail || !guardHealthy) {
    badWindow = true;
    reason = driftFail ? 'drift_above_target' : 'guard_metrics_degraded';
  }

  const next = normalizeState(state, policy);
  next.windows_seen = Number(next.windows_seen || 0) + 1;
  next.last_window_date = dateStr;

  if (goodWindow) {
    next.good_window_streak = Number(next.good_window_streak || 0) + 1;
    next.bad_window_streak = 0;
  } else if (badWindow) {
    next.bad_window_streak = Number(next.bad_window_streak || 0) + 1;
    next.good_window_streak = 0;
  } else {
    next.good_window_streak = 0;
    next.bad_window_streak = 0;
  }

  const daysSinceAdjustment = dateDiffDays(dateStr, next.last_adjustment_date);
  const adjustmentCooldownMet = daysSinceAdjustment == null
    || daysSinceAdjustment >= Number(policy.ratchet.min_windows_between_adjustments || 0);

  let targetAfter = Number(next.current_target_rate);
  let adjustedThisWindow = false;
  if (goodWindow
      && adjustmentCooldownMet
      && next.good_window_streak >= Number(policy.ratchet.good_window_streak_required || 1)) {
    const tightened = clampNumber(
      targetAfter - Number(policy.ratchet.tighten_step_rate || 0),
      Number(policy.metric.floor_target_rate),
      Number(policy.metric.ceiling_target_rate),
      targetAfter
    );
    if (tightened < targetAfter) {
      action = 'tighten';
      reason = 'good_window_streak';
      targetAfter = tightened;
      adjustedThisWindow = true;
      next.adjustments_count = Number(next.adjustments_count || 0) + 1;
      next.last_adjustment_date = dateStr;
      next.good_window_streak = 0;
    }
  } else if (badWindow
      && adjustmentCooldownMet
      && next.bad_window_streak >= Number(policy.ratchet.bad_window_streak_required || 1)) {
    const loosened = clampNumber(
      targetAfter + Number(policy.ratchet.loosen_step_rate || 0),
      Number(policy.metric.floor_target_rate),
      Number(policy.metric.ceiling_target_rate),
      targetAfter
    );
    if (loosened > targetAfter) {
      action = 'loosen';
      reason = 'bad_window_streak';
      targetAfter = loosened;
      adjustedThisWindow = true;
      next.adjustments_count = Number(next.adjustments_count || 0) + 1;
      next.last_adjustment_date = dateStr;
      next.bad_window_streak = 0;
    }
  }

  next.current_target_rate = Number(targetAfter.toFixed(6));
  const tritShadow = driftTritShadowDecision(
    {
      ...metrics,
      drift_rate: driftRate
    },
    target,
    policy,
    next,
    {
      enough_samples: enoughSamples,
      verified_pass: verifiedPass,
      shipped_pass: shippedPass,
      adjustment_cooldown_met: adjustmentCooldownMet,
      good_window: goodWindow,
      bad_window: badWindow,
      good_window_streak: next.good_window_streak,
      bad_window_streak: next.bad_window_streak,
      adjusted_this_window: adjustedThisWindow
    },
    {
      trit_policy: tritPolicy,
      source_trust: tritSourceTrust
    }
  );
  const tritShadowInfluence = driftTritShadowInfluenceDecision(
    action,
    tritShadow,
    {
      enough_samples: enoughSamples,
      verified_pass: verifiedPass,
      shipped_pass: shippedPass,
      adjustment_cooldown_met: adjustmentCooldownMet
    },
    tritPolicy,
    tritStage,
    tritGuardState,
    dateStr
  );
  if (tritShadowInfluence && tritShadowInfluence.apply === true && tritShadowInfluence.action) {
    action = String(tritShadowInfluence.action);
    reason = `trit_shadow_${String(tritShadowInfluence.reason || 'influence')}`;
    if (action === 'tighten' && targetAfter >= Number(next.current_target_rate)) {
      const tightened = clampNumber(
        Number(next.current_target_rate) - Number(policy.ratchet.tighten_step_rate || 0),
        Number(policy.metric.floor_target_rate),
        Number(policy.metric.ceiling_target_rate),
        Number(next.current_target_rate)
      );
      if (tightened < Number(next.current_target_rate)) {
        targetAfter = tightened;
        adjustedThisWindow = true;
        next.adjustments_count = Number(next.adjustments_count || 0) + 1;
        next.last_adjustment_date = dateStr;
      }
    } else if (action === 'loosen' && targetAfter <= Number(next.current_target_rate)) {
      const loosened = clampNumber(
        Number(next.current_target_rate) + Number(policy.ratchet.loosen_step_rate || 0),
        Number(policy.metric.floor_target_rate),
        Number(policy.metric.ceiling_target_rate),
        Number(next.current_target_rate)
      );
      if (loosened > Number(next.current_target_rate)) {
        targetAfter = loosened;
        adjustedThisWindow = true;
        next.adjustments_count = Number(next.adjustments_count || 0) + 1;
        next.last_adjustment_date = dateStr;
      }
    }
    if (tritShadowInfluence.override === true) {
      consumeTritShadowOverride('drift_target_governor', tritPolicy, dateStr);
    }
  }
  next.current_target_rate = Number(targetAfter.toFixed(6));
  const decision = {
    ts: nowIso(),
    date: dateStr,
    source,
    action,
    reason,
    metric_key_used: driftPick.key,
    drift_rate: driftRate != null ? Number(driftRate.toFixed(6)) : null,
    target_before: Number(target.toFixed(6)),
    target_after: Number(next.current_target_rate.toFixed(6)),
    guards: {
      enough_samples: enoughSamples,
      min_samples: minSamples,
      verified_rate: metrics.verified_rate,
      min_verified_rate: Number(policy.guards.min_verified_rate || 0),
      shipped_rate: metrics.shipped_rate,
      min_shipped_rate: Number(policy.guards.min_shipped_rate || 0)
    },
    streaks: {
      good_window_streak: next.good_window_streak,
      bad_window_streak: next.bad_window_streak
    },
    trit_shadow: tritShadow
      ? {
        enabled: true,
        action: tritShadow.action,
        reason: tritShadow.reason,
        divergence: tritShadow.action !== action,
        belief: tritShadow.belief,
        evidence_guard: tritShadow.evidence_guard || null,
        top_sources: tritShadow.top_sources
      }
      : null,
    trit_shadow_influence: tritShadowInfluence || null
  };
  next.last_decision = decision;
  const history = Array.isArray(next.history) ? next.history.slice() : [];
  history.push(decision);
  next.history = history.slice(-Number(policy.ratchet.history_limit || 180));
  next.updated_at = decision.ts;

  if (opts.write !== false) writeJsonAtomic(statePath, next);

  return {
    ok: true,
    ts: nowIso(),
    policy,
    state: next,
    decision,
    trit_shadow: tritShadow
      ? {
        ...tritShadow,
        divergence: tritShadow.action !== action
      }
      : null,
    trit_shadow_influence: tritShadowInfluence || null,
    trit_shadow_runtime: {
      stage: tritStage,
      stage_source: tritStageDecision && tritStageDecision.source ? String(tritStageDecision.source) : null,
      base_stage: tritStageDecision && tritStageDecision.base_stage != null ? Number(tritStageDecision.base_stage) : null,
      auto_stage: tritStageDecision && tritStageDecision.auto_stage ? tritStageDecision.auto_stage : null,
      policy_path: String(process.env.AUTONOMY_TRIT_SHADOW_POLICY_PATH || '').trim() || null
    },
    metrics,
    source,
    state_path: statePath
  };
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/autonomy/drift_target_governor.js run [YYYY-MM-DD] [--write=1|0] [--drift-rate=0.02] [--verified-rate=0.8] [--shipped-rate=0.3] [--attempted=10]');
  console.log('  node systems/autonomy/drift_target_governor.js run [YYYY-MM-DD] --from=health [--write=1|0]');
  console.log('  node systems/autonomy/drift_target_governor.js status');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeText(args._[0] || 'run').toLowerCase();
  if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
    usage();
    return;
  }
  const policy = loadPolicy(DEFAULT_POLICY_PATH);
  if (cmd === 'status') {
    const state = loadState(policy, DEFAULT_STATE_PATH);
    process.stdout.write(`${JSON.stringify({
      ok: true,
      ts: nowIso(),
      policy,
      state,
      state_path: DEFAULT_STATE_PATH
    }, null, 2)}\n`);
    return;
  }
  if (cmd !== 'run') {
    usage();
    process.exit(2);
  }
  const dateStr = resolveDateArg(args);
  const write = String(args.write == null ? '1' : args.write).trim() !== '0';
  let metrics = {
    error_rate_recent: normalizeRate(args['drift-rate'] != null ? args['drift-rate'] : args.error_rate_recent),
    spc_stop_ratio: normalizeRate(args.spc_stop_ratio),
    simulation_drift_rate: normalizeRate(args.simulation_drift_rate),
    verified_rate: normalizeRate(args['verified-rate'] != null ? args['verified-rate'] : args.verified_rate),
    shipped_rate: normalizeRate(args['shipped-rate'] != null ? args['shipped-rate'] : args.shipped_rate),
    attempted: Math.max(0, Math.round(Number(args.attempted || 0)))
  };
  let source = 'manual';
  if (normalizeText(args.from).toLowerCase() === 'health') {
    const derived = deriveMetricsFromHealthReport(dateStr);
    metrics = { ...derived.metrics };
    source = 'health_report';
  }
  const out = evaluateWindow({ ...metrics, source }, {
    policy,
    dateStr,
    write
  });
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

if (require.main === module) {
  main();
}

module.exports = {
  defaultPolicy,
  normalizePolicy,
  loadPolicy,
  defaultState,
  normalizeState,
  loadState,
  deriveMetricsFromHealthPayload,
  deriveMetricsFromHealthReport,
  driftTritShadowDecision,
  driftTritShadowInfluenceDecision,
  evaluateWindow
};
