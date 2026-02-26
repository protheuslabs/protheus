#!/usr/bin/env node
'use strict';
export {};

/**
 * strategy_mode_governor.js
 *
 * Deterministic strategy mode governor:
 * - score_only -> canary_execute when readiness passes
 * - canary_execute -> execute when canary metrics pass (optional)
 * - execute/canary_execute -> safer mode when readiness fails
 *
 * Usage:
 *   node systems/autonomy/strategy_mode_governor.js run [YYYY-MM-DD] [--days=N] [--id=<strategy_id>] [--strict] [--dry-run]
 *   node systems/autonomy/strategy_mode_governor.js status [YYYY-MM-DD] [--days=N] [--id=<strategy_id>] [--strict]
 *   node systems/autonomy/strategy_mode_governor.js --help
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  loadActiveStrategy,
  strategyExecutionMode,
  strategyPromotionPolicy
} = require('../../lib/strategy_resolver');
const { evaluateTernaryBelief } = require('../../lib/ternary_belief_engine');
const { queueForApproval, loadQueue } = require('../../lib/approval_gate');
const { loadOutcomeFitnessPolicy } = require('../../lib/outcome_fitness');
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
const { summarizeForDate } = require('./receipt_summary');
const { evaluateReadiness } = require('./strategy_readiness');
const { evaluatePipelineSpcGate } = require('./pipeline_spc_gate');

type AnyObj = Record<string, any>;

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const POLICY_ROOT_SCRIPT = path.join(REPO_ROOT, 'systems', 'security', 'policy_rootd.js');
const MODE_AUDIT_LOG_PATH = process.env.AUTONOMY_STRATEGY_MODE_LOG
  ? path.resolve(process.env.AUTONOMY_STRATEGY_MODE_LOG)
  : path.join(REPO_ROOT, 'state', 'autonomy', 'strategy_mode_changes.jsonl');
const MODE_GOVERNOR_STATE_PATH = process.env.AUTONOMY_STRATEGY_MODE_GOVERNOR_STATE
  ? path.resolve(process.env.AUTONOMY_STRATEGY_MODE_GOVERNOR_STATE)
  : path.join(REPO_ROOT, 'state', 'autonomy', 'strategy_mode_governor_state.json');
const MODE_GOVERNOR_MIN_HOURS_BETWEEN_CHANGES = Number(process.env.AUTONOMY_MODE_GOVERNOR_MIN_HOURS_BETWEEN_CHANGES || 6);
const MODE_GOVERNOR_PROMOTE_CANARY = String(process.env.AUTONOMY_MODE_GOVERNOR_PROMOTE_CANARY || '1') !== '0';
const MODE_GOVERNOR_PROMOTE_EXECUTE = String(process.env.AUTONOMY_MODE_GOVERNOR_PROMOTE_EXECUTE || '0') === '1';
const MODE_GOVERNOR_ALLOW_AUTO_ESCALATION = String(process.env.AUTONOMY_MODE_GOVERNOR_ALLOW_AUTO_ESCALATION || '0') === '1';
const MODE_GOVERNOR_REQUIRE_POLICY_ROOT = String(process.env.AUTONOMY_MODE_GOVERNOR_REQUIRE_POLICY_ROOT || '1') !== '0';
const MODE_GOVERNOR_DEMOTE_NOT_READY = String(process.env.AUTONOMY_MODE_GOVERNOR_DEMOTE_NOT_READY || '1') !== '0';
const MODE_GOVERNOR_CANARY_MIN_ATTEMPTED = Number(process.env.AUTONOMY_MODE_GOVERNOR_CANARY_MIN_ATTEMPTED || 3);
const MODE_GOVERNOR_CANARY_MIN_VERIFIED_RATE = Number(process.env.AUTONOMY_MODE_GOVERNOR_CANARY_MIN_VERIFIED_RATE || 0.75);
const MODE_GOVERNOR_CANARY_MAX_FAIL_RATE = Number(process.env.AUTONOMY_MODE_GOVERNOR_CANARY_MAX_FAIL_RATE || 0.25);
const MODE_GOVERNOR_CANARY_MIN_SHIPPED = Number(process.env.AUTONOMY_MODE_GOVERNOR_CANARY_MIN_SHIPPED || 1);
const MODE_GOVERNOR_CANARY_MIN_SUCCESS_CRITERIA_RECEIPTS = Number(process.env.AUTONOMY_MODE_GOVERNOR_CANARY_MIN_SUCCESS_CRITERIA_RECEIPTS || 1);
const MODE_GOVERNOR_CANARY_MIN_SUCCESS_CRITERIA_PASS_RATE = Number(process.env.AUTONOMY_MODE_GOVERNOR_CANARY_MIN_SUCCESS_CRITERIA_PASS_RATE || 0.6);
const MODE_GOVERNOR_CANARY_DISABLE_LEGACY_FALLBACK_AFTER_QUALITY_RECEIPTS = Number(
  process.env.AUTONOMY_MODE_GOVERNOR_CANARY_DISABLE_LEGACY_FALLBACK_AFTER_QUALITY_RECEIPTS || 10
);
const MODE_GOVERNOR_CANARY_MAX_SUCCESS_CRITERIA_QUALITY_INSUFFICIENT_RATE = Number(
  process.env.AUTONOMY_MODE_GOVERNOR_CANARY_MAX_SUCCESS_CRITERIA_QUALITY_INSUFFICIENT_RATE || 0.4
);
const MODE_GOVERNOR_CANARY_MIN_PREVIEW_SUCCESS_CRITERIA_RECEIPTS = Number(process.env.AUTONOMY_MODE_GOVERNOR_CANARY_MIN_PREVIEW_SUCCESS_CRITERIA_RECEIPTS || 1);
const MODE_GOVERNOR_CANARY_MIN_PREVIEW_SUCCESS_CRITERIA_PASS_RATE = Number(process.env.AUTONOMY_MODE_GOVERNOR_CANARY_MIN_PREVIEW_SUCCESS_CRITERIA_PASS_RATE || 0.55);
const MODE_GOVERNOR_REQUIRE_QUALITY_LOCK_FOR_EXECUTE = String(
  process.env.AUTONOMY_MODE_GOVERNOR_REQUIRE_QUALITY_LOCK_FOR_EXECUTE || '1'
) !== '0';
const MODE_GOVERNOR_QUALITY_LOCK_FLAP_THRESHOLD = Number(process.env.AUTONOMY_MODE_GOVERNOR_QUALITY_LOCK_FLAP_THRESHOLD || 2);
const MODE_GOVERNOR_QUALITY_LOCK_FLAP_WINDOW_HOURS = Number(process.env.AUTONOMY_MODE_GOVERNOR_QUALITY_LOCK_FLAP_WINDOW_HOURS || 24);
const MODE_GOVERNOR_EXECUTE_FREEZE_HOURS = Number(process.env.AUTONOMY_MODE_GOVERNOR_EXECUTE_FREEZE_HOURS || 12);
const MODE_GOVERNOR_NOW_ISO = String(process.env.AUTONOMY_MODE_GOVERNOR_NOW_ISO || '').trim();
const MODE_GOVERNOR_CANARY_RELAX_ENABLED = String(process.env.AUTONOMY_CANARY_RELAX_ENABLED || '1') !== '0';
const MODE_GOVERNOR_CANARY_RELAX_READINESS_CHECKS = new Set(
  String(process.env.AUTONOMY_CANARY_RELAX_READINESS_CHECKS || 'success_criteria_pass_rate')
    .split(',')
    .map((v) => String(v || '').trim())
    .filter(Boolean)
);
const MODE_GOVERNOR_REQUIRE_SPC = String(process.env.AUTONOMY_MODE_GOVERNOR_REQUIRE_SPC || '1') !== '0';
const MODE_GOVERNOR_SPC_BASELINE_DAYS = Number(process.env.AUTONOMY_MODE_GOVERNOR_SPC_BASELINE_DAYS || 21);
const MODE_GOVERNOR_SPC_BASELINE_MIN_DAYS = Number(process.env.AUTONOMY_MODE_GOVERNOR_SPC_BASELINE_MIN_DAYS || 7);
const MODE_GOVERNOR_SPC_SIGMA = Number(process.env.AUTONOMY_MODE_GOVERNOR_SPC_SIGMA || 3);
const MODE_GOVERNOR_MIN_ESCALATE_STREAK = Number(process.env.AUTONOMY_MODE_GOVERNOR_MIN_ESCALATE_STREAK || 2);
const MODE_GOVERNOR_MIN_DEMOTE_STREAK = Number(process.env.AUTONOMY_MODE_GOVERNOR_MIN_DEMOTE_STREAK || 1);
const MODE_GOVERNOR_QUEUE_DUAL_CONTROL = String(process.env.AUTONOMY_MODE_GOVERNOR_QUEUE_DUAL_CONTROL || '1') !== '0';
const MODE_GOVERNOR_TRIT_SHADOW_ENABLED = String(process.env.AUTONOMY_MODE_GOVERNOR_TRIT_SHADOW_ENABLED || '1') !== '0';

function usage() {
  console.log('Usage:');
  console.log('  node systems/autonomy/strategy_mode_governor.js run [YYYY-MM-DD] [--days=N] [--id=<strategy_id>] [--strict] [--dry-run] [--lease-token=<token>]');
  console.log('  node systems/autonomy/strategy_mode_governor.js status [YYYY-MM-DD] [--days=N] [--id=<strategy_id>] [--strict]');
  console.log('  node systems/autonomy/strategy_mode_governor.js --help');
}

function parseArgs(argv: string[]): AnyObj {
  const out: AnyObj = { _: [] };
  for (const arg of argv) {
    if (!arg.startsWith('--')) {
      out._.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq === -1) out[arg.slice(2)] = true;
    else out[arg.slice(2, eq)] = arg.slice(eq + 1);
  }
  return out;
}

function canaryFailedChecksAllowed(failedChecks) {
  const failed = Array.isArray(failedChecks)
    ? failedChecks.map((v) => String(v || '').trim()).filter(Boolean)
    : [];
  if (!failed.length || MODE_GOVERNOR_CANARY_RELAX_READINESS_CHECKS.size === 0) return false;
  for (const check of failed) {
    if (!MODE_GOVERNOR_CANARY_RELAX_READINESS_CHECKS.has(check)) return false;
  }
  return true;
}

function readinessState(mode, readiness) {
  const strictReady = !!(readiness && readiness.ready_for_execute === true);
  const failedChecks = Array.isArray(readiness && readiness.failed_checks)
    ? readiness.failed_checks
    : [];
  const canaryRelaxed = MODE_GOVERNOR_CANARY_RELAX_ENABLED
    && canaryFailedChecksAllowed(failedChecks);
  const readyForCanary = strictReady || canaryRelaxed;
  const readyForExecute = strictReady;
  const effectiveReady = mode === 'execute' ? readyForExecute : readyForCanary;
  return {
    strict_ready: strictReady,
    canary_relaxed: canaryRelaxed,
    ready_for_canary: readyForCanary,
    ready_for_execute: readyForExecute,
    effective_ready: effectiveReady,
    failed_checks: failedChecks
  };
}

function modeTritShadowDecision(currentMode, readiness, canary, policy, spc, executeFreeze, transition, tritCtx: AnyObj = {}) {
  if (!MODE_GOVERNOR_TRIT_SHADOW_ENABLED) return null;
  const mode = String(currentMode || '');
  const rs = readinessState(mode, readiness);
  const qualityLockRequired = !!(policy && policy.canary_require_quality_lock_for_execute === true);
  const qualityLockActive = !!(canary && canary.metrics && canary.metrics.quality_lock_active === true);
  const spcPass = !policy || policy.require_spc !== true || !!(spc && spc.pass === true && spc.hold_escalation !== true);
  const freezeActive = !!(executeFreeze && executeFreeze.active === true);

  const signals = [
    { source: 'ready_for_canary', trit: rs.ready_for_canary ? 1 : -1, weight: 1.1 },
    { source: 'ready_for_execute', trit: rs.ready_for_execute ? 1 : -1, weight: 1.3 },
    {
      source: 'canary_preview',
      trit: canary && canary.preview_ready_for_canary === false ? -1 : 1,
      weight: 1
    },
    {
      source: 'canary_execute',
      trit: canary && canary.ready_for_execute === false ? -1 : 1,
      weight: 1.1
    },
    { source: 'spc_gate', trit: spcPass ? 1 : -1, weight: 1.4 },
    {
      source: 'quality_lock',
      trit: qualityLockRequired ? (qualityLockActive ? 1 : -1) : 0,
      weight: 1.2
    },
    { source: 'execute_freeze', trit: freezeActive ? -1 : 1, weight: 1.4 },
    {
      source: 'hysteresis_streak',
      trit: Number(tritCtx && tritCtx.escalate_ready_streak || 0) >= Number(policy && policy.min_escalate_streak || 1) ? 1 : 0,
      weight: 0.7
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
    label: 'strategy_mode_governor_shadow',
    positive_threshold: 0.18,
    negative_threshold: -0.18,
    evidence_saturation_count: 6,
    source_trust: tritCtx && tritCtx.source_trust ? tritCtx.source_trust : null,
    source_trust_floor: trust.source_trust_floor,
    source_trust_ceiling: trust.source_trust_ceiling,
    freshness_half_life_hours: trust.freshness_half_life_hours,
    min_non_neutral_signals: semantics.min_non_neutral_signals,
    min_non_neutral_weight: semantics.min_non_neutral_weight,
    min_confidence_for_non_neutral: semantics.min_confidence_for_non_neutral,
    force_neutral_on_insufficient_evidence: semantics.neutral_on_missing !== false
  });

  let shadowToMode = null;
  let shadowReason = 'hold';
  if (mode === 'score_only') {
    if (
      Number(belief.trit || 0) === 1
      && rs.ready_for_canary
      && (!canary || canary.preview_ready_for_canary !== false)
      && spcPass
    ) {
      shadowToMode = 'canary_execute';
      shadowReason = 'shadow_promote_canary';
    }
  } else if (mode === 'canary_execute') {
    if (Number(belief.trit || 0) === 1 && rs.ready_for_execute && canary && canary.ready_for_execute === true && spcPass) {
      shadowToMode = 'execute';
      shadowReason = 'shadow_promote_execute';
    } else if (Number(belief.trit || 0) === -1 && !rs.ready_for_canary) {
      shadowToMode = 'score_only';
      shadowReason = 'shadow_demote_score_only';
    }
  } else if (mode === 'execute') {
    const needsDemotion = !rs.ready_for_execute || (qualityLockRequired && !qualityLockActive) || freezeActive;
    if (Number(belief.trit || 0) === -1 && needsDemotion) {
      shadowToMode = 'canary_execute';
      shadowReason = freezeActive ? 'shadow_execute_freeze_demote' : 'shadow_demote_canary';
    }
  }

  const legacyToMode = transition && transition.to_mode ? String(transition.to_mode) : null;
  const divergence = (legacyToMode || '') !== (shadowToMode || '');
  const evidenceGuard = belief && belief.evidence_guard && typeof belief.evidence_guard === 'object'
    ? belief.evidence_guard
    : null;
  return {
    enabled: true,
    current_mode: mode,
    legacy_to_mode: legacyToMode,
    shadow_to_mode: shadowToMode,
    divergence,
    reason: shadowReason,
    belief: {
      trit: Number(belief.trit || 0),
      label: String(belief.trit_label || 'unknown'),
      score: Number(Number(belief.score || 0).toFixed(4)),
      confidence: Number(Number(belief.confidence || 0).toFixed(4)),
      evidence_count: Number(belief.evidence_count || 0)
    },
    evidence_guard: evidenceGuard,
    top_sources: Array.isArray(belief.top_sources) ? belief.top_sources.slice(0, 5) : []
  };
}

function tritShadowInfluenceDecision(
  status,
  transition,
  tritPolicy,
  stage,
  guardState,
  dateStr
) {
  const shadow = status && status.trit_shadow && typeof status.trit_shadow === 'object' ? status.trit_shadow : null;
  if (!shadow || shadow.enabled !== true) {
    return { enabled: false, stage, apply: false, reason: 'shadow_unavailable' };
  }
  if (!shadow.shadow_to_mode) {
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

  const target = String(shadow.shadow_to_mode || '');
  const rs = status && status.readiness_effective && typeof status.readiness_effective === 'object'
    ? status.readiness_effective
    : {};
  const canary = status && status.canary && typeof status.canary === 'object' ? status.canary : {};
  const executeFreeze = status && status.execute_freeze && typeof status.execute_freeze === 'object'
    ? status.execute_freeze
    : {};
  const spc = status && status.spc && typeof status.spc === 'object' ? status.spc : null;
  const policy = status && status.policy && typeof status.policy === 'object' ? status.policy : {};

  if (target === 'execute') {
    if (rs.ready_for_execute !== true) return { enabled: true, stage, apply: false, reason: 'execute_not_ready' };
    if (canary.ready_for_execute !== true) return { enabled: true, stage, apply: false, reason: 'execute_canary_gate_failed' };
    if (executeFreeze.active === true) return { enabled: true, stage, apply: false, reason: 'execute_freeze_active' };
    if (policy.require_spc === true && (!spc || spc.pass !== true || spc.hold_escalation === true)) {
      return { enabled: true, stage, apply: false, reason: 'execute_spc_gate_failed' };
    }
    if (
      policy.canary_require_quality_lock_for_execute === true
      && !(canary && canary.metrics && canary.metrics.quality_lock_active === true)
    ) {
      return { enabled: true, stage, apply: false, reason: 'execute_quality_lock_inactive' };
    }
  } else if (target === 'canary_execute') {
    if (rs.ready_for_canary !== true) return { enabled: true, stage, apply: false, reason: 'canary_not_ready' };
    if (canary.preview_ready_for_canary === false) {
      return { enabled: true, stage, apply: false, reason: 'canary_preview_gate_failed' };
    }
    if (policy.require_spc === true && (!spc || spc.pass !== true || spc.hold_escalation === true)) {
      return { enabled: true, stage, apply: false, reason: 'canary_spc_gate_failed' };
    }
  }

  const legacyToMode = transition && transition.to_mode ? String(transition.to_mode) : null;
  if (legacyToMode && legacyToMode === target) {
    return { enabled: true, stage, apply: false, reason: 'already_matches_legacy', to_mode: target };
  }

  const override = !!legacyToMode && legacyToMode !== target;
  if (override && stage < 3) {
    return { enabled: true, stage, apply: false, reason: 'stage2_no_override', to_mode: target };
  }

  if (override) {
    const budget = canConsumeTritShadowOverride(tritPolicy, dateStr);
    if (!budget.allowed) {
      return { enabled: true, stage, apply: false, reason: budget.reason || 'override_budget_denied', to_mode: target, budget };
    }
    return {
      enabled: true,
      stage,
      apply: true,
      to_mode: target,
      reason: 'budgeted_shadow_override',
      override: true,
      budget
    };
  }

  return {
    enabled: true,
    stage,
    apply: true,
    to_mode: target,
    reason: 'shadow_fill_gap',
    override: false
  };
}

function nowIso() {
  return new Date(nowMs()).toISOString();
}

function nowMs() {
  if (MODE_GOVERNOR_NOW_ISO) {
    const n = Date.parse(MODE_GOVERNOR_NOW_ISO);
    if (Number.isFinite(n)) return n;
  }
  return Date.now();
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function isDateStr(v) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
}

function clampInt(v, lo, hi, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}

function appendJsonl(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, JSON.stringify(obj) + '\n', 'utf8');
}

function readJsonl(filePath) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const rows = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
    const out = [];
    for (const row of rows) {
      try { out.push(JSON.parse(row)); } catch {}
    }
    return out;
  } catch {
    return [];
  }
}

function loadGovernorState() {
  const raw = readJsonSafe(MODE_GOVERNOR_STATE_PATH, {});
  const byStrategy = raw && raw.by_strategy && typeof raw.by_strategy === 'object'
    ? raw.by_strategy
    : {};
  return {
    version: '1.0',
    by_strategy: byStrategy
  };
}

function saveGovernorState(state) {
  const next = state && typeof state === 'object' ? state : { version: '1.0', by_strategy: {} };
  writeJsonAtomic(MODE_GOVERNOR_STATE_PATH, next);
}

function strategyStreak(state, strategyId) {
  const root = state && typeof state === 'object' ? state : {};
  const by = root.by_strategy && typeof root.by_strategy === 'object' ? root.by_strategy : {};
  const row = by[strategyId] && typeof by[strategyId] === 'object' ? by[strategyId] : {};
  const demotionEvents = Array.isArray(row.quality_lock_demotion_events)
    ? row.quality_lock_demotion_events
      .map((v) => String(v || '').trim())
      .filter(Boolean)
    : [];
  return {
    escalate_ready_streak: Math.max(0, Number(row.escalate_ready_streak || 0)),
    demote_not_ready_streak: Math.max(0, Number(row.demote_not_ready_streak || 0)),
    last_eval_ts: row.last_eval_ts ? String(row.last_eval_ts) : null,
    quality_lock_demotion_events: demotionEvents,
    execute_freeze_until_ts: row.execute_freeze_until_ts ? String(row.execute_freeze_until_ts) : null,
    execute_freeze_reason: row.execute_freeze_reason ? String(row.execute_freeze_reason) : null
  };
}

function loadStrategy(args) {
  return loadActiveStrategy({
    allowMissing: false,
    strict: args.strict === true,
    id: args.id ? String(args.id) : undefined
  });
}

function governorPolicy() {
  return {
    min_hours_between_changes: Math.max(0, Number.isFinite(MODE_GOVERNOR_MIN_HOURS_BETWEEN_CHANGES) ? MODE_GOVERNOR_MIN_HOURS_BETWEEN_CHANGES : 0),
    promote_canary: MODE_GOVERNOR_PROMOTE_CANARY,
    promote_execute: MODE_GOVERNOR_PROMOTE_EXECUTE,
    require_policy_root: MODE_GOVERNOR_REQUIRE_POLICY_ROOT,
    demote_not_ready: MODE_GOVERNOR_DEMOTE_NOT_READY,
    canary_min_attempted: Math.max(0, Number(MODE_GOVERNOR_CANARY_MIN_ATTEMPTED || 0)),
    canary_min_verified_rate: Math.max(0, Math.min(1, Number(MODE_GOVERNOR_CANARY_MIN_VERIFIED_RATE || 0))),
    canary_max_fail_rate: Math.max(0, Math.min(1, Number(MODE_GOVERNOR_CANARY_MAX_FAIL_RATE || 1))),
    canary_min_shipped: Math.max(0, Number(MODE_GOVERNOR_CANARY_MIN_SHIPPED || 0)),
    canary_min_success_criteria_receipts: Math.max(0, Number(MODE_GOVERNOR_CANARY_MIN_SUCCESS_CRITERIA_RECEIPTS || 0)),
    canary_min_success_criteria_pass_rate: Math.max(0, Math.min(1, Number(MODE_GOVERNOR_CANARY_MIN_SUCCESS_CRITERIA_PASS_RATE || 0))),
    canary_disable_legacy_fallback_after_quality_receipts: Math.max(
      0,
      Number(MODE_GOVERNOR_CANARY_DISABLE_LEGACY_FALLBACK_AFTER_QUALITY_RECEIPTS || 0)
    ),
    canary_max_success_criteria_quality_insufficient_rate: Math.max(
      0,
      Math.min(1, Number(MODE_GOVERNOR_CANARY_MAX_SUCCESS_CRITERIA_QUALITY_INSUFFICIENT_RATE || 1))
    ),
    canary_min_preview_success_criteria_receipts: Math.max(0, Number(MODE_GOVERNOR_CANARY_MIN_PREVIEW_SUCCESS_CRITERIA_RECEIPTS || 0)),
    canary_min_preview_success_criteria_pass_rate: Math.max(0, Math.min(1, Number(MODE_GOVERNOR_CANARY_MIN_PREVIEW_SUCCESS_CRITERIA_PASS_RATE || 0))),
    canary_require_quality_lock_for_execute: MODE_GOVERNOR_REQUIRE_QUALITY_LOCK_FOR_EXECUTE,
    quality_lock_flap_threshold: Math.max(1, Number(MODE_GOVERNOR_QUALITY_LOCK_FLAP_THRESHOLD || 2)),
    quality_lock_flap_window_hours: Math.max(1, Number(MODE_GOVERNOR_QUALITY_LOCK_FLAP_WINDOW_HOURS || 24)),
    execute_freeze_hours: Math.max(1, Number(MODE_GOVERNOR_EXECUTE_FREEZE_HOURS || 12)),
    require_spc: MODE_GOVERNOR_REQUIRE_SPC,
    spc_baseline_days: Math.max(3, Number(MODE_GOVERNOR_SPC_BASELINE_DAYS || 21)),
    spc_baseline_min_days: Math.max(1, Number(MODE_GOVERNOR_SPC_BASELINE_MIN_DAYS || 7)),
    spc_sigma: Math.max(0.1, Number(MODE_GOVERNOR_SPC_SIGMA || 3)),
    min_escalate_streak: Math.max(1, Number(MODE_GOVERNOR_MIN_ESCALATE_STREAK || 1)),
    min_demote_streak: Math.max(1, Number(MODE_GOVERNOR_MIN_DEMOTE_STREAK || 1))
  };
}

function lastModeChangeEvent(strategyId) {
  const rows = readJsonl(MODE_AUDIT_LOG_PATH);
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (!row || !row.type) continue;
    const t = String(row.type);
    if (t !== 'strategy_mode_change' && t !== 'strategy_mode_auto_change' && t !== 'strategy_mode_auto_revert') continue;
    if (strategyId && String(row.strategy_id || '') !== String(strategyId)) continue;
    return row;
  }
  return null;
}

function cooldownState(last, minHours) {
  const out = {
    active: false,
    remaining_minutes: 0,
    min_hours_between_changes: minHours
  };
  if (!last || !last.ts || !Number.isFinite(minHours) || minHours <= 0) return out;
  const ts = new Date(String(last.ts));
  if (Number.isNaN(ts.getTime())) return out;
  const minMs = minHours * 60 * 60 * 1000;
  const ageMs = nowMs() - ts.getTime();
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs >= minMs) return out;
  out.active = true;
  out.remaining_minutes = Math.ceil((minMs - ageMs) / (60 * 1000));
  return out;
}

function computeExecuteFreezeState(policy, prevStreak) {
  const row = prevStreak && typeof prevStreak === 'object' ? prevStreak : {};
  const now = nowMs();
  const windowMs = Math.max(1, Number(policy.quality_lock_flap_window_hours || 24)) * 60 * 60 * 1000;
  const rawEvents = Array.isArray(row.quality_lock_demotion_events) ? row.quality_lock_demotion_events : [];
  const events = [];
  for (const ts of rawEvents) {
    const s = String(ts || '').trim();
    if (!s) continue;
    const ms = Date.parse(s);
    if (!Number.isFinite(ms)) continue;
    if (ms > now) continue;
    if ((now - ms) > windowMs) continue;
    events.push(new Date(ms).toISOString());
  }
  events.sort();
  const untilRaw = String(row.execute_freeze_until_ts || '').trim();
  const untilMs = untilRaw ? Date.parse(untilRaw) : NaN;
  const active = Number.isFinite(untilMs) && untilMs > now;
  const remainingMinutes = active ? Math.ceil((untilMs - now) / (60 * 1000)) : 0;
  return {
    active,
    until_ts: active ? new Date(untilMs).toISOString() : null,
    remaining_minutes: remainingMinutes,
    reason: active ? String(row.execute_freeze_reason || 'quality_lock_flap_circuit_open') : null,
    flap_threshold: Math.max(1, Number(policy.quality_lock_flap_threshold || 2)),
    flap_window_hours: Math.max(1, Number(policy.quality_lock_flap_window_hours || 24)),
    freeze_hours: Math.max(1, Number(policy.execute_freeze_hours || 12)),
    recent_demotion_count: events.length,
    recent_demotion_event_ts: events
  };
}

function canaryMetrics(summary, policy, qualityLock) {
  const attempted = Number(summary?.receipts?.combined?.attempted || 0);
  const verifiedRate = Number(summary?.receipts?.combined?.verified_rate || 0);
  const autonomyFail = Number(summary?.receipts?.autonomy?.fail || 0);
  const actuationFail = Number(summary?.receipts?.actuation?.failed || 0);
  const criteriaQualityReceipts = Number(summary?.receipts?.autonomy?.success_criteria_quality_receipts || 0);
  const criteriaQualityPassRate = Number(summary?.receipts?.autonomy?.success_criteria_quality_receipt_pass_rate || 0);
  const criteriaLegacyReceipts = Number(summary?.receipts?.autonomy?.success_criteria_receipts || 0);
  const criteriaLegacyPassRate = Number(summary?.receipts?.autonomy?.success_criteria_receipt_pass_rate || 0);
  const criteriaQualityInsufficientReceipts = Number(
    summary?.receipts?.autonomy?.success_criteria_quality_insufficient_receipts
    || summary?.receipts?.autonomy?.success_criteria_quality_filtered_receipts
    || 0
  );
  const criteriaQualityInsufficientRateRaw = Number(summary?.receipts?.autonomy?.success_criteria_quality_insufficient_rate);
  const criteriaQualityInsufficientRate = Number.isFinite(criteriaQualityInsufficientRateRaw)
    ? criteriaQualityInsufficientRateRaw
    : (criteriaLegacyReceipts > 0 ? (criteriaQualityInsufficientReceipts / criteriaLegacyReceipts) : 0);
  const previewQualityCriteriaReceipts = Number(summary?.receipts?.autonomy?.success_criteria_quality_preview_receipts || 0);
  const previewQualityCriteriaPassRate = Number(summary?.receipts?.autonomy?.success_criteria_quality_preview_pass_rate || 0);
  const previewLegacyCriteriaReceipts = Number(summary?.receipts?.autonomy?.success_criteria_preview_receipts || 0);
  const previewLegacyCriteriaPassRate = Number(summary?.receipts?.autonomy?.success_criteria_preview_pass_rate || 0);
  const forceQualityCriteria = criteriaQualityReceipts >= policy.canary_disable_legacy_fallback_after_quality_receipts;
  const useQualityCriteria = forceQualityCriteria || criteriaQualityReceipts >= policy.canary_min_success_criteria_receipts;
  const criteriaReceipts = useQualityCriteria ? criteriaQualityReceipts : criteriaLegacyReceipts;
  const criteriaPassRate = useQualityCriteria ? criteriaQualityPassRate : criteriaLegacyPassRate;
  const useQualityPreviewCriteria = previewQualityCriteriaReceipts >= policy.canary_min_preview_success_criteria_receipts;
  const previewCriteriaReceipts = useQualityPreviewCriteria ? previewQualityCriteriaReceipts : previewLegacyCriteriaReceipts;
  const previewCriteriaPassRate = useQualityPreviewCriteria ? previewQualityCriteriaPassRate : previewLegacyCriteriaPassRate;
  const criteriaSource = useQualityCriteria
    ? (forceQualityCriteria ? 'quality_forced' : 'quality')
    : 'legacy_fallback';
  const previewCriteriaSource = useQualityPreviewCriteria ? 'quality' : 'legacy_fallback';
  const failCount = autonomyFail + actuationFail;
  const failRate = attempted > 0 ? failCount / attempted : 1;
  const shipped = Number(summary?.runs?.executed_outcomes?.shipped || 0);
  const qualityLockState = qualityLock && typeof qualityLock === 'object' ? qualityLock : {};
  const qualityLockActive = qualityLockState.active === true;
  const checks = [
    {
      name: 'attempted',
      pass: attempted >= policy.canary_min_attempted,
      value: attempted,
      target: `>=${policy.canary_min_attempted}`
    },
    {
      name: 'verified_rate',
      pass: verifiedRate >= policy.canary_min_verified_rate,
      value: Number(verifiedRate.toFixed(3)),
      target: `>=${policy.canary_min_verified_rate}`
    },
    {
      name: 'fail_rate',
      pass: failRate <= policy.canary_max_fail_rate,
      value: Number(failRate.toFixed(3)),
      target: `<=${policy.canary_max_fail_rate}`
    },
    {
      name: 'shipped',
      pass: shipped >= policy.canary_min_shipped,
      value: shipped,
      target: `>=${policy.canary_min_shipped}`
    },
    {
      name: 'success_criteria_receipts',
      pass: criteriaReceipts >= policy.canary_min_success_criteria_receipts,
      value: criteriaReceipts,
      target: `>=${policy.canary_min_success_criteria_receipts}`
    },
    {
      name: 'success_criteria_pass_rate',
      pass: criteriaReceipts >= policy.canary_min_success_criteria_receipts
        && criteriaPassRate >= policy.canary_min_success_criteria_pass_rate,
      value: criteriaReceipts >= policy.canary_min_success_criteria_receipts
        ? Number(criteriaPassRate.toFixed(3))
        : null,
      target: criteriaReceipts >= policy.canary_min_success_criteria_receipts
        ? `>=${policy.canary_min_success_criteria_pass_rate}`
        : `requires_receipts>=${policy.canary_min_success_criteria_receipts}`
    },
    {
      name: 'success_criteria_quality_insufficient_rate',
      pass: forceQualityCriteria
        ? criteriaQualityInsufficientRate <= policy.canary_max_success_criteria_quality_insufficient_rate
        : true,
      value: forceQualityCriteria
        ? Number(criteriaQualityInsufficientRate.toFixed(3))
        : null,
      target: forceQualityCriteria
        ? `<=${policy.canary_max_success_criteria_quality_insufficient_rate}`
        : 'n/a(pre_fallback_retirement)'
    },
    {
      name: 'quality_lock_active',
      pass: policy.canary_require_quality_lock_for_execute !== true || qualityLockActive,
      value: policy.canary_require_quality_lock_for_execute === true ? qualityLockActive : null,
      target: policy.canary_require_quality_lock_for_execute === true ? 'true' : 'n/a(disabled)'
    },
    {
      name: 'preview_success_criteria_receipts',
      pass: previewCriteriaReceipts >= policy.canary_min_preview_success_criteria_receipts,
      value: previewCriteriaReceipts,
      target: `>=${policy.canary_min_preview_success_criteria_receipts}`
    },
    {
      name: 'preview_success_criteria_pass_rate',
      pass: previewCriteriaReceipts >= policy.canary_min_preview_success_criteria_receipts
        && previewCriteriaPassRate >= policy.canary_min_preview_success_criteria_pass_rate,
      value: previewCriteriaReceipts >= policy.canary_min_preview_success_criteria_receipts
        ? Number(previewCriteriaPassRate.toFixed(3))
        : null,
      target: previewCriteriaReceipts >= policy.canary_min_preview_success_criteria_receipts
        ? `>=${policy.canary_min_preview_success_criteria_pass_rate}`
        : `requires_preview_receipts>=${policy.canary_min_preview_success_criteria_receipts}`
    }
  ];
  const failed = checks.filter(c => c.pass !== true).map(c => c.name);
  return {
    ready_for_execute: failed.length === 0,
    preview_ready_for_canary: previewCriteriaReceipts >= policy.canary_min_preview_success_criteria_receipts
      && previewCriteriaPassRate >= policy.canary_min_preview_success_criteria_pass_rate,
    failed_checks: failed,
    checks,
    metrics: {
      attempted,
      verified_rate: Number(verifiedRate.toFixed(3)),
      fail_rate: Number(failRate.toFixed(3)),
      shipped,
      success_criteria_receipts: criteriaReceipts,
      success_criteria_source: criteriaSource,
      success_criteria_fallback_retired: forceQualityCriteria,
      success_criteria_quality_receipts: criteriaQualityReceipts,
      success_criteria_legacy_receipts: criteriaLegacyReceipts,
      success_criteria_quality_insufficient_receipts: criteriaQualityInsufficientReceipts,
      success_criteria_quality_insufficient_rate: Number(criteriaQualityInsufficientRate.toFixed(3)),
      min_success_criteria_receipts: policy.canary_min_success_criteria_receipts,
      disable_legacy_fallback_after_quality_receipts: policy.canary_disable_legacy_fallback_after_quality_receipts,
      max_success_criteria_quality_insufficient_rate: policy.canary_max_success_criteria_quality_insufficient_rate,
      success_criteria_pass_rate: criteriaReceipts >= policy.canary_min_success_criteria_receipts
        ? Number(criteriaPassRate.toFixed(3))
        : null,
      preview_success_criteria_receipts: previewCriteriaReceipts,
      preview_success_criteria_source: previewCriteriaSource,
      preview_success_criteria_quality_receipts: previewQualityCriteriaReceipts,
      preview_success_criteria_legacy_receipts: previewLegacyCriteriaReceipts,
      min_preview_success_criteria_receipts: policy.canary_min_preview_success_criteria_receipts,
      preview_success_criteria_pass_rate: previewCriteriaReceipts >= policy.canary_min_preview_success_criteria_receipts
        ? Number(previewCriteriaPassRate.toFixed(3))
        : null,
      quality_lock_active: qualityLockActive,
      require_quality_lock_for_execute: policy.canary_require_quality_lock_for_execute === true,
      quality_lock_stable_window_streak: Number(qualityLockState.stable_window_streak || 0),
      quality_lock_path: qualityLockState.path ? String(qualityLockState.path) : null
    }
  };
}

function runPolicyRootAuthorize({ scope, target, leaseToken, approvalNote, source }) {
  const args = [
    POLICY_ROOT_SCRIPT,
    'authorize',
    `--scope=${String(scope || '').trim()}`,
    `--target=${String(target || '').trim()}`,
    `--approval-note=${String(approvalNote || '').trim()}`
  ];
  if (leaseToken) args.push(`--lease-token=${String(leaseToken).trim()}`);
  if (source) args.push(`--source=${String(source).trim()}`);
  const r = spawnSync('node', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8'
  });
  const stdout = String(r.stdout || '').trim();
  const stderr = String(r.stderr || '').trim();
  let payload = null;
  if (stdout) {
    try { payload = JSON.parse(stdout); } catch {}
  }
  return {
    ok: r.status === 0 && payload && payload.ok === true && payload.decision === 'ALLOW',
    code: Number(r.status || 0),
    payload,
    stderr,
    stdout
  };
}

function sanitizeToken(v) {
  return String(v || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'unknown';
}

function dualControlActionId(strategyId, fromMode, toMode) {
  const sid = sanitizeToken(strategyId).slice(0, 32);
  const from = sanitizeToken(fromMode).slice(0, 16);
  const to = sanitizeToken(toMode).slice(0, 16);
  return `act_modegov_${sid}_${from}_to_${to}`;
}

function queueDualControlApprovalRequest({ strategy, fromMode, toMode, requiredCommand }) {
  const actionId = dualControlActionId(strategy && strategy.id, fromMode, toMode);
  if (!MODE_GOVERNOR_QUEUE_DUAL_CONTROL) {
    return { queued: false, enabled: false, action_id: actionId };
  }
  let pendingEntry = null;
  try {
    const q = loadQueue();
    const pending = q && Array.isArray(q.pending) ? q.pending : [];
    pendingEntry = pending.find((e) => String(e && e.action_id || '') === actionId) || null;
  } catch {}

  if (pendingEntry) {
    return {
      queued: false,
      deduped: true,
      enabled: true,
      action_id: actionId,
      status: String(pendingEntry.status || 'PENDING')
    };
  }

  const summary = `Promote strategy mode ${String(strategy && strategy.id || 'unknown')} from ${String(fromMode || 'unknown')} to ${String(toMode || 'unknown')}`;
  const reason = `Dual-control required for strategy mode escalation. Run: ${String(requiredCommand || '').slice(0, 300)}`;
  const queued = queueForApproval({
    action_id: actionId,
    directive_id: 'T0_invariants',
    type: 'strategy_mode_escalation',
    summary
  }, reason);
  return {
    queued: true,
    deduped: false,
    enabled: true,
    action_id: actionId,
    status: String(queued && queued.status || 'PENDING')
  };
}

function modeRank(mode) {
  const m = String(mode || '');
  if (m === 'score_only') return 0;
  if (m === 'canary_execute') return 1;
  if (m === 'execute') return 2;
  return -1;
}

function isEscalation(fromMode, toMode) {
  const fromRank = modeRank(fromMode);
  const toRank = modeRank(toMode);
  return fromRank >= 0 && toRank >= 0 && toRank > fromRank;
}

function spcAllowsEscalation(spc, policy) {
  if (!policy || policy.require_spc !== true) return true;
  return !!(spc && spc.pass === true && spc.hold_escalation !== true);
}

function computeStreakUpdate(currentMode, readiness, canary, policy, spc, prevStreak) {
  const mode = String(currentMode || '');
  const rs = readinessState(mode, readiness);
  const spcReady = spcAllowsEscalation(spc, policy);
  const previewReady = !canary || canary.preview_ready_for_canary !== false;
  const executeReady = !!(canary && canary.ready_for_execute === true);
  const executeQualityLockRequired = mode === 'execute' && policy && policy.canary_require_quality_lock_for_execute === true;
  const executeQualityLockActive = !!(canary && canary.metrics && canary.metrics.quality_lock_active === true);
  const prev = prevStreak && typeof prevStreak === 'object' ? prevStreak : {};
  let escalateReady = false;
  if (mode === 'score_only') escalateReady = rs.ready_for_canary && previewReady && spcReady;
  else if (mode === 'canary_execute') escalateReady = rs.ready_for_execute && executeReady && spcReady;
  const demoteNotReady = mode === 'execute'
    ? (!rs.ready_for_execute || (executeQualityLockRequired && !executeQualityLockActive))
    : !rs.ready_for_canary;
  return {
    escalate_ready_streak: escalateReady ? Math.max(0, Number(prev.escalate_ready_streak || 0)) + 1 : 0,
    demote_not_ready_streak: demoteNotReady ? Math.max(0, Number(prev.demote_not_ready_streak || 0)) + 1 : 0,
    last_eval_ts: nowIso()
  };
}

function decideTransition(currentMode, readiness, canary, policy, spc, streak) {
  const mode = String(currentMode || '');
  const rs = readinessState(mode, readiness);
  const escalateStreak = Math.max(0, Number(streak && streak.escalate_ready_streak || 0));
  const demoteStreak = Math.max(0, Number(streak && streak.demote_not_ready_streak || 0));
  const escalateReady = escalateStreak >= Number(policy && policy.min_escalate_streak || 1);
  const demoteReady = demoteStreak >= Number(policy && policy.min_demote_streak || 1);
  if (mode === 'score_only') {
    if (!policy.promote_canary) return null;
    if (rs.ready_for_canary && canary && canary.preview_ready_for_canary !== false && spcAllowsEscalation(spc, policy) && escalateReady) {
      return {
        to_mode: 'canary_execute',
        reason: 'readiness_pass_promote_canary',
        cooldown_exempt: false,
        streaks: { escalate_ready_streak: escalateStreak, required: Number(policy && policy.min_escalate_streak || 1) }
      };
    }
    return null;
  }

  if (mode === 'canary_execute') {
    if (policy.demote_not_ready && !rs.ready_for_canary && demoteReady) {
      return {
        to_mode: 'score_only',
        reason: 'readiness_fail_demote_score_only',
        cooldown_exempt: true,
        streaks: { demote_not_ready_streak: demoteStreak, required: Number(policy && policy.min_demote_streak || 1) }
      };
    }
    if (policy.promote_execute && rs.ready_for_execute && canary && canary.ready_for_execute === true && spcAllowsEscalation(spc, policy) && escalateReady) {
      return {
        to_mode: 'execute',
        reason: 'canary_metrics_pass_promote_execute',
        cooldown_exempt: false,
        streaks: { escalate_ready_streak: escalateStreak, required: Number(policy && policy.min_escalate_streak || 1) }
      };
    }
    return null;
  }

  if (mode === 'execute') {
    const qualityLockRequired = policy && policy.canary_require_quality_lock_for_execute === true;
    const qualityLockActive = !!(canary && canary.metrics && canary.metrics.quality_lock_active === true);
    const needsDemotion = !rs.ready_for_execute || (qualityLockRequired && !qualityLockActive);
    if (policy.demote_not_ready && needsDemotion && demoteReady) {
      return {
        to_mode: 'canary_execute',
        reason: !rs.ready_for_execute
          ? 'readiness_fail_demote_canary'
          : 'quality_lock_inactive_demote_canary',
        cooldown_exempt: true,
        streaks: { demote_not_ready_streak: demoteStreak, required: Number(policy && policy.min_demote_streak || 1) }
      };
    }
  }
  return null;
}

function applyMode(strategy, toMode) {
  const raw = readJsonSafe(strategy.file, {});
  const next = raw && typeof raw === 'object' ? { ...raw } : {};
  next.execution_policy = {
    ...(next.execution_policy && typeof next.execution_policy === 'object' ? next.execution_policy : {}),
    mode: toMode
  };
  writeJsonAtomic(strategy.file, next);
}

function buildStatus(dateStr, days, strategy, policy, prevStreak) {
  const tritPolicy = loadTritShadowPolicy();
  const tritTrustState = loadTritShadowTrustState(tritPolicy);
  const tritSourceTrust = buildTritSourceTrustMap(tritTrustState);
  const tritStageDecision = resolveTritShadowStageDecision(tritPolicy);
  const tritStage = Number(tritStageDecision && tritStageDecision.stage || resolveTritShadowStage(tritPolicy));
  const tritGuardState = loadTritShadowInfluenceGuard();
  const promotion = strategyPromotionPolicy(strategy, {});
  const effectivePolicy = {
    ...policy,
    canary_disable_legacy_fallback_after_quality_receipts: Number.isFinite(Number(promotion.disable_legacy_fallback_after_quality_receipts))
      ? Number(promotion.disable_legacy_fallback_after_quality_receipts)
      : Number(policy.canary_disable_legacy_fallback_after_quality_receipts || 10),
    canary_max_success_criteria_quality_insufficient_rate: Number.isFinite(Number(promotion.max_success_criteria_quality_insufficient_rate))
      ? Number(promotion.max_success_criteria_quality_insufficient_rate)
      : Number(policy.canary_max_success_criteria_quality_insufficient_rate || 0.4)
  };
  const windowDays = Math.max(Number(promotion.min_days || 7), clampInt(days, 1, 30, Number(promotion.min_days || 7)));
  const summary = summarizeForDate(dateStr, windowDays);
  const outcomePolicy = loadOutcomeFitnessPolicy(REPO_ROOT);
  const qualityLock = {
    path: outcomePolicy && outcomePolicy.path ? outcomePolicy.path : null,
    ...(outcomePolicy
      && outcomePolicy.strategy_policy
      && outcomePolicy.strategy_policy.promotion_policy_audit
      && outcomePolicy.strategy_policy.promotion_policy_audit.quality_lock
      && typeof outcomePolicy.strategy_policy.promotion_policy_audit.quality_lock === 'object'
      ? outcomePolicy.strategy_policy.promotion_policy_audit.quality_lock
      : {})
  };
  const readiness = evaluateReadiness(strategy, summary, promotion, windowDays);
  const mode = strategyExecutionMode(strategy, 'execute');
  const canary = canaryMetrics(summary, effectivePolicy, qualityLock);
  const spc = effectivePolicy.require_spc
    ? evaluatePipelineSpcGate(dateStr, {
      days: windowDays,
      baseline_days: effectivePolicy.spc_baseline_days,
      baseline_min_days: effectivePolicy.spc_baseline_min_days,
      sigma: effectivePolicy.spc_sigma
    })
    : null;
  const nextStreak = computeStreakUpdate(mode, readiness, canary, effectivePolicy, spc, prevStreak);
  const executeFreeze = computeExecuteFreezeState(effectivePolicy, prevStreak);
  const last = lastModeChangeEvent(strategy.id);
  const cooldown = cooldownState(last, effectivePolicy.min_hours_between_changes);
  let transition: AnyObj | null = decideTransition(mode, readiness, canary, effectivePolicy, spc, nextStreak);
  if (transition && String(transition.to_mode || '') === 'execute' && executeFreeze.active) {
    transition = null;
  }
  const tritShadow = modeTritShadowDecision(mode, readiness, canary, effectivePolicy, spc, executeFreeze, transition, {
    trit_policy: tritPolicy,
    source_trust: tritSourceTrust,
    escalate_ready_streak: nextStreak && nextStreak.escalate_ready_streak
  });
  const readinessEval = readinessState(mode, readiness);
  const tritShadowInfluence = tritShadowInfluenceDecision(
    {
      trit_shadow: tritShadow,
      readiness_effective: readinessEval,
      canary,
      execute_freeze: executeFreeze,
      spc,
      policy: effectivePolicy
    },
    transition,
    tritPolicy,
    tritStage,
    tritGuardState,
    dateStr
  );
  if (
    tritShadowInfluence
    && tritShadowInfluence.apply === true
    && tritShadowInfluence.to_mode
    && (!transition || String(transition.to_mode || '') !== String(tritShadowInfluence.to_mode || ''))
  ) {
    transition = {
      to_mode: String(tritShadowInfluence.to_mode),
      reason: `trit_shadow_${String(tritShadowInfluence.reason || 'influence')}`,
      cooldown_exempt: false,
      trit_shadow_influence: true,
      trit_shadow_override: tritShadowInfluence.override === true
    };
  }
  const transitionBlockReason = (
    mode === 'score_only'
    && readinessEval.ready_for_canary === true
    && canary
    && canary.preview_ready_for_canary === false
  ) ? 'preview_success_criteria_below_min'
    : (
      ((mode === 'score_only' || mode === 'canary_execute')
      && ((mode === 'canary_execute' ? readinessEval.ready_for_execute : readinessEval.ready_for_canary) === true)
      && canary
      && ((mode !== 'score_only') || canary.preview_ready_for_canary !== false)
      && effectivePolicy.require_spc
      && spc
      && spc.hold_escalation === true)
        ? 'spc_gate_failed'
        : null
    );
  const freezeBlockReason = !transition
    && mode === 'canary_execute'
    && executeFreeze.active
    && readinessEval.ready_for_execute === true
    && canary
    && canary.ready_for_execute === true
    ? 'execute_freeze_active'
    : null;
  const streakBlockReason = !transition && !freezeBlockReason
    ? ((mode === 'score_only' || mode === 'canary_execute')
      && Number(nextStreak.escalate_ready_streak || 0) > 0
      && Number(nextStreak.escalate_ready_streak || 0) < Number(effectivePolicy.min_escalate_streak || 1)
        ? 'hysteresis_wait_escalate_streak'
        : (
          mode !== 'score_only'
          && Number(nextStreak.demote_not_ready_streak || 0) > 0
          && Number(nextStreak.demote_not_ready_streak || 0) < Number(effectivePolicy.min_demote_streak || 1)
            ? 'hysteresis_wait_demote_streak'
            : null
        ))
    : null;
  return {
    date: dateStr,
    days: windowDays,
    strategy,
    policy: effectivePolicy,
    summary,
    readiness,
    readiness_effective: readinessEval,
    canary,
    execute_freeze: executeFreeze,
    spc,
    streak: nextStreak,
    current_mode: mode,
    last_mode_change: last ? {
      ts: String(last.ts || ''),
      type: String(last.type || ''),
      from_mode: String(last.from_mode || ''),
      to_mode: String(last.to_mode || '')
    } : null,
    cooldown,
    transition,
    trit_shadow: tritShadow,
    trit_shadow_influence: tritShadowInfluence,
    trit_shadow_runtime: {
      stage: tritStage,
      stage_source: tritStageDecision && tritStageDecision.source ? String(tritStageDecision.source) : null,
      base_stage: tritStageDecision && tritStageDecision.base_stage != null ? Number(tritStageDecision.base_stage) : null,
      auto_stage: tritStageDecision && tritStageDecision.auto_stage ? tritStageDecision.auto_stage : null,
      policy_path: String(process.env.AUTONOMY_TRIT_SHADOW_POLICY_PATH || '').trim() || null
    },
    transition_block_reason: transitionBlockReason || freezeBlockReason || streakBlockReason
  };
}

function cmdStatus(args) {
  const dateStr = isDateStr(args._[1]) ? String(args._[1]) : todayStr();
  const strategy = loadStrategy(args);
  const policy = governorPolicy();
  const state = loadGovernorState();
  const prevStreak = strategyStreak(state, strategy.id);
  const status = buildStatus(dateStr, args.days, strategy, policy, prevStreak);
  process.stdout.write(JSON.stringify({
    ok: true,
    ts: nowIso(),
    date: status.date,
    days: status.days,
    strategy: {
      id: strategy.id,
      mode: status.current_mode,
      file: path.relative(REPO_ROOT, strategy.file).replace(/\\/g, '/')
    },
    readiness: status.readiness,
    canary: status.canary,
    execute_freeze: status.execute_freeze,
    spc: status.spc,
    streak: status.streak,
    trit_shadow: status.trit_shadow,
    trit_shadow_influence: status.trit_shadow_influence,
    trit_shadow_runtime: status.trit_shadow_runtime,
    policy: status.policy,
    cooldown: status.cooldown,
    transition: status.transition
  }, null, 2) + '\n');
}

function cmdRun(args) {
  const dateStr = isDateStr(args._[1]) ? String(args._[1]) : todayStr();
  const dryRun = args['dry-run'] === true || args.dry_run === true;
  const leaseToken = String(args['lease-token'] || args.lease_token || process.env.CAPABILITY_LEASE_TOKEN || '').trim();
  const strategy = loadStrategy(args);
  const policy = governorPolicy();
  const state = loadGovernorState();
  const prevStreak = strategyStreak(state, strategy.id);
  const status = buildStatus(dateStr, args.days, strategy, policy, prevStreak);
  state.by_strategy = state.by_strategy && typeof state.by_strategy === 'object' ? state.by_strategy : {};
  const nextStateRow = {
    ...status.streak,
    quality_lock_demotion_events: Array.isArray(status.execute_freeze && status.execute_freeze.recent_demotion_event_ts)
      ? status.execute_freeze.recent_demotion_event_ts
      : [],
    execute_freeze_until_ts: status.execute_freeze && status.execute_freeze.active
      ? String(status.execute_freeze.until_ts || '')
      : null,
    execute_freeze_reason: status.execute_freeze && status.execute_freeze.active
      ? String(status.execute_freeze.reason || 'quality_lock_flap_circuit_open')
      : null,
    updated_at: nowIso()
  };
  state.by_strategy[strategy.id] = nextStateRow;
  saveGovernorState(state);
  const fromMode = status.current_mode;
  const transition = status.transition;
  const tritInfluence = status.trit_shadow_influence && typeof status.trit_shadow_influence === 'object'
    ? status.trit_shadow_influence
    : null;

  if (!transition) {
    if (status.transition_block_reason === 'execute_freeze_active') {
      appendJsonl(MODE_AUDIT_LOG_PATH, {
        ts: nowIso(),
        type: 'strategy_mode_auto_blocked',
        strategy_id: strategy.id,
        file: path.relative(REPO_ROOT, strategy.file).replace(/\\/g, '/'),
        from_mode: fromMode,
        to_mode: 'execute',
        reason: 'execute_freeze_active',
        execute_freeze: status.execute_freeze,
        governor_policy: policy,
        readiness: status.readiness,
        canary: status.canary,
        trit_shadow: status.trit_shadow,
        trit_shadow_influence: tritInfluence,
        spc: status.spc,
        streak: status.streak
      });
    }
    process.stdout.write(JSON.stringify({
      ok: true,
      ts: nowIso(),
      result: 'no_change',
      strategy_id: strategy.id,
      mode: fromMode,
      reason: status.transition_block_reason || 'no_transition_rule_triggered',
      readiness: status.readiness,
      canary: status.canary,
      trit_shadow: status.trit_shadow,
      trit_shadow_influence: tritInfluence,
      trit_shadow_runtime: status.trit_shadow_runtime,
      execute_freeze: status.execute_freeze,
      spc: status.spc,
      streak: status.streak
    }, null, 2) + '\n');
    return;
  }

  const cooldown = status.cooldown;
  if (!transition.cooldown_exempt && cooldown.active) {
    process.stdout.write(JSON.stringify({
      ok: true,
      ts: nowIso(),
      result: 'cooldown_blocked',
      strategy_id: strategy.id,
      from_mode: fromMode,
      to_mode: transition.to_mode,
      reason: transition.reason,
      cooldown,
      trit_shadow: status.trit_shadow,
      trit_shadow_influence: tritInfluence,
      trit_shadow_runtime: status.trit_shadow_runtime,
      execute_freeze: status.execute_freeze,
      spc: status.spc,
      streak: status.streak
    }, null, 2) + '\n');
    return;
  }

  if (dryRun) {
    process.stdout.write(JSON.stringify({
      ok: true,
      ts: nowIso(),
      result: 'dry_run',
      strategy_id: strategy.id,
      from_mode: fromMode,
      to_mode: transition.to_mode,
      reason: transition.reason,
      readiness: status.readiness,
      canary: status.canary,
      trit_shadow: status.trit_shadow,
      trit_shadow_influence: tritInfluence,
      trit_shadow_runtime: status.trit_shadow_runtime,
      execute_freeze: status.execute_freeze,
      spc: status.spc,
      streak: status.streak
    }, null, 2) + '\n');
    return;
  }

  if (isEscalation(fromMode, transition.to_mode) && !MODE_GOVERNOR_ALLOW_AUTO_ESCALATION) {
    const requiredCommand = `node systems/autonomy/strategy_mode.js set --mode=${transition.to_mode} --approval-note="<reason>" --approver-id=<id> --second-approver-id=<id> --second-approval-note="<reason>"`;
    const approvalQueue = queueDualControlApprovalRequest({
      strategy,
      fromMode,
      toMode: transition.to_mode,
      requiredCommand
    });
    const evt = {
      ts: nowIso(),
      type: 'strategy_mode_auto_blocked',
      strategy_id: strategy.id,
      file: path.relative(REPO_ROOT, strategy.file).replace(/\\/g, '/'),
      from_mode: fromMode,
      to_mode: transition.to_mode,
      reason: 'dual_control_required_for_escalation',
      required_command: requiredCommand,
      approval_queue: approvalQueue,
      governor_policy: policy,
      readiness: status.readiness,
      canary: status.canary,
      trit_shadow: status.trit_shadow,
      trit_shadow_influence: tritInfluence,
      spc: status.spc,
      streak: status.streak
    };
    appendJsonl(MODE_AUDIT_LOG_PATH, evt);
    process.stdout.write(JSON.stringify({
      ok: true,
      ts: nowIso(),
      result: 'blocked_dual_control_required',
      ...evt
    }, null, 2) + '\n');
    return;
  }

  if (isEscalation(fromMode, transition.to_mode) && MODE_GOVERNOR_REQUIRE_POLICY_ROOT) {
    const pr = runPolicyRootAuthorize({
      scope: 'strategy_mode_escalation',
      target: strategy.id,
      leaseToken,
      approvalNote: `governor_auto_escalation ${fromMode}->${transition.to_mode}`,
      source: 'strategy_mode_governor'
    });
    if (!pr.ok) {
      const evt = {
        ts: nowIso(),
        type: 'strategy_mode_auto_blocked',
        strategy_id: strategy.id,
        file: path.relative(REPO_ROOT, strategy.file).replace(/\\/g, '/'),
        from_mode: fromMode,
        to_mode: transition.to_mode,
        reason: 'policy_root_denied',
        detail: pr.stderr || pr.stdout || `policy_root_exit_${pr.code}`,
        policy_root: pr.payload || null,
        governor_policy: policy,
        readiness: status.readiness,
        canary: status.canary,
        trit_shadow: status.trit_shadow,
        trit_shadow_influence: tritInfluence,
        spc: status.spc,
        streak: status.streak
      };
      appendJsonl(MODE_AUDIT_LOG_PATH, evt);
      process.stdout.write(JSON.stringify({
        ok: true,
        ts: nowIso(),
        result: 'blocked_policy_root',
        ...evt
      }, null, 2) + '\n');
      return;
    }
  }

  let tritOverrideBudget = null;
  if (tritInfluence && tritInfluence.apply === true && tritInfluence.override === true) {
    const tritPolicy = loadTritShadowPolicy();
    tritOverrideBudget = consumeTritShadowOverride('strategy_mode_governor', tritPolicy, dateStr);
  }

  applyMode(strategy, transition.to_mode);
  const evt: AnyObj = {
    ts: nowIso(),
    type: 'strategy_mode_auto_change',
    strategy_id: strategy.id,
    file: path.relative(REPO_ROOT, strategy.file).replace(/\\/g, '/'),
    from_mode: fromMode,
    to_mode: transition.to_mode,
    reason: transition.reason,
    cooldown_exempt: transition.cooldown_exempt === true,
    governor_policy: policy,
    readiness: status.readiness,
    canary: status.canary,
    trit_shadow: status.trit_shadow,
    trit_shadow_influence: tritInfluence,
    trit_shadow_runtime: status.trit_shadow_runtime,
    trit_shadow_override_budget: tritOverrideBudget,
    spc: status.spc,
    streak: status.streak
  };
  if (transition.reason === 'quality_lock_inactive_demote_canary') {
    const now = nowMs();
    const windowMs = Math.max(1, Number(policy.quality_lock_flap_window_hours || 24)) * 60 * 60 * 1000;
    const freezeMs = Math.max(1, Number(policy.execute_freeze_hours || 12)) * 60 * 60 * 1000;
    const threshold = Math.max(1, Number(policy.quality_lock_flap_threshold || 2));
    const priorEvents = Array.isArray(nextStateRow.quality_lock_demotion_events)
      ? nextStateRow.quality_lock_demotion_events
      : [];
    const withCurrent = [...priorEvents, nowIso()];
    const kept = [];
    for (const ts of withCurrent) {
      const ms = Date.parse(String(ts || ''));
      if (!Number.isFinite(ms) || ms > now) continue;
      if ((now - ms) > windowMs) continue;
      kept.push(new Date(ms).toISOString());
    }
    kept.sort();
    nextStateRow.quality_lock_demotion_events = kept;
    const demotionCount = kept.length;
    if (demotionCount >= threshold) {
      const until = new Date(now + freezeMs).toISOString();
      nextStateRow.execute_freeze_until_ts = until;
      nextStateRow.execute_freeze_reason = 'quality_lock_flap_circuit_open';
      evt.execute_freeze_armed = {
        active: true,
        until_ts: until,
        reason: 'quality_lock_flap_circuit_open',
        threshold,
        flap_window_hours: Number(policy.quality_lock_flap_window_hours || 24),
        freeze_hours: Number(policy.execute_freeze_hours || 12),
        demotion_count: demotionCount
      };
      appendJsonl(MODE_AUDIT_LOG_PATH, {
        ts: nowIso(),
        type: 'strategy_mode_execute_freeze_armed',
        strategy_id: strategy.id,
        file: path.relative(REPO_ROOT, strategy.file).replace(/\\/g, '/'),
        reason: 'quality_lock_flap_circuit_open',
        execute_freeze: evt.execute_freeze_armed,
        demotion_events: kept
      });
    }
  }
  appendJsonl(MODE_AUDIT_LOG_PATH, evt);

  state.by_strategy[strategy.id] = {
    ...nextStateRow,
    escalate_ready_streak: 0,
    demote_not_ready_streak: 0,
    last_eval_ts: nowIso()
  };
  saveGovernorState(state);

  process.stdout.write(JSON.stringify({
    ok: true,
    ts: nowIso(),
    result: 'mode_changed',
    ...evt
  }, null, 2) + '\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim();
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'status') return cmdStatus(args);
  if (cmd === 'run') return cmdRun(args);
  usage();
  process.exit(2);
}

if (require.main === module) {
  main();
}

module.exports = {
  canaryMetrics,
  decideTransition,
  modeTritShadowDecision,
  tritShadowInfluenceDecision
};
