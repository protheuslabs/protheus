#!/usr/bin/env node
'use strict';

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
} = require('../../lib/strategy_resolver.js');
const { loadOutcomeFitnessPolicy } = require('../../lib/outcome_fitness.js');
const { summarizeForDate } = require('./receipt_summary.js');
const { evaluateReadiness } = require('./strategy_readiness.js');
const { evaluatePipelineSpcGate } = require('./pipeline_spc_gate.js');

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

function usage() {
  console.log('Usage:');
  console.log('  node systems/autonomy/strategy_mode_governor.js run [YYYY-MM-DD] [--days=N] [--id=<strategy_id>] [--strict] [--dry-run] [--lease-token=<token>]');
  console.log('  node systems/autonomy/strategy_mode_governor.js status [YYYY-MM-DD] [--days=N] [--id=<strategy_id>] [--strict]');
  console.log('  node systems/autonomy/strategy_mode_governor.js --help');
}

function parseArgs(argv) {
  const out = { _: [] };
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

function nowIso() {
  return new Date().toISOString();
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
  return {
    escalate_ready_streak: Math.max(0, Number(row.escalate_ready_streak || 0)),
    demote_not_ready_streak: Math.max(0, Number(row.demote_not_ready_streak || 0)),
    last_eval_ts: row.last_eval_ts ? String(row.last_eval_ts) : null
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
  const ageMs = Date.now() - ts.getTime();
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs >= minMs) return out;
  out.active = true;
  out.remaining_minutes = Math.ceil((minMs - ageMs) / (60 * 1000));
  return out;
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
    summary?.receipts?.autonomy?.success_criteria_quality_filtered_receipts
    || summary?.receipts?.autonomy?.success_criteria_quality_insufficient_receipts
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
      pass: useQualityCriteria
        ? criteriaQualityInsufficientRate <= policy.canary_max_success_criteria_quality_insufficient_rate
        : true,
      value: useQualityCriteria
        ? Number(criteriaQualityInsufficientRate.toFixed(3))
        : null,
      target: useQualityCriteria
        ? `<=${policy.canary_max_success_criteria_quality_insufficient_rate}`
        : 'n/a(legacy_fallback)'
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
  const last = lastModeChangeEvent(strategy.id);
  const cooldown = cooldownState(last, effectivePolicy.min_hours_between_changes);
  const transition = decideTransition(mode, readiness, canary, effectivePolicy, spc, nextStreak);
  const readinessEval = readinessState(mode, readiness);
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
  const streakBlockReason = !transition && (mode === 'score_only' || mode === 'canary_execute')
    && Number(nextStreak.escalate_ready_streak || 0) > 0
    && Number(nextStreak.escalate_ready_streak || 0) < Number(effectivePolicy.min_escalate_streak || 1)
      ? 'hysteresis_wait_escalate_streak'
      : (
        !transition && mode !== 'score_only'
        && Number(nextStreak.demote_not_ready_streak || 0) > 0
        && Number(nextStreak.demote_not_ready_streak || 0) < Number(effectivePolicy.min_demote_streak || 1)
          ? 'hysteresis_wait_demote_streak'
          : null
      );
  return {
    date: dateStr,
    days: windowDays,
    strategy,
    policy: effectivePolicy,
    summary,
    readiness,
    readiness_effective: readinessEval,
    canary,
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
    transition_block_reason: transitionBlockReason || streakBlockReason
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
    spc: status.spc,
    streak: status.streak,
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
  state.by_strategy[strategy.id] = {
    ...status.streak,
    updated_at: nowIso()
  };
  saveGovernorState(state);
  const fromMode = status.current_mode;
  const transition = status.transition;

  if (!transition) {
    process.stdout.write(JSON.stringify({
      ok: true,
      ts: nowIso(),
      result: 'no_change',
      strategy_id: strategy.id,
      mode: fromMode,
      reason: status.transition_block_reason || 'no_transition_rule_triggered',
      readiness: status.readiness,
      canary: status.canary,
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
      spc: status.spc,
      streak: status.streak
    }, null, 2) + '\n');
    return;
  }

  if (isEscalation(fromMode, transition.to_mode) && !MODE_GOVERNOR_ALLOW_AUTO_ESCALATION) {
    const evt = {
      ts: nowIso(),
      type: 'strategy_mode_auto_blocked',
      strategy_id: strategy.id,
      file: path.relative(REPO_ROOT, strategy.file).replace(/\\/g, '/'),
      from_mode: fromMode,
      to_mode: transition.to_mode,
      reason: 'dual_control_required_for_escalation',
      required_command: `node systems/autonomy/strategy_mode.js set --mode=${transition.to_mode} --approval-note="<reason>" --approver-id=<id> --second-approver-id=<id> --second-approval-note="<reason>"`,
      governor_policy: policy,
      readiness: status.readiness,
      canary: status.canary,
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

  applyMode(strategy, transition.to_mode);
  const evt = {
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
    spc: status.spc,
    streak: status.streak
  };
  appendJsonl(MODE_AUDIT_LOG_PATH, evt);

  state.by_strategy[strategy.id] = {
    escalate_ready_streak: 0,
    demote_not_ready_streak: 0,
    last_eval_ts: nowIso(),
    updated_at: nowIso()
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
  decideTransition
};
