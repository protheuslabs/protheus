'use strict';
export {};

const fs = require('fs');
const path = require('path');

type AnyObj = Record<string, any>;

function repoRoot() {
  return path.resolve(__dirname, '..');
}

const POLICY_PATH = process.env.AUTONOMY_TRIT_SHADOW_POLICY_PATH
  ? path.resolve(process.env.AUTONOMY_TRIT_SHADOW_POLICY_PATH)
  : path.join(repoRoot(), 'config', 'trit_shadow_policy.json');
const SUCCESS_CRITERIA_PATH = process.env.AUTONOMY_TRIT_SHADOW_SUCCESS_CRITERIA_PATH
  ? path.resolve(process.env.AUTONOMY_TRIT_SHADOW_SUCCESS_CRITERIA_PATH)
  : path.join(repoRoot(), 'config', 'trit_shadow_success_criteria.json');
const TRUST_STATE_PATH = process.env.AUTONOMY_TRIT_SHADOW_TRUST_STATE_PATH
  ? path.resolve(process.env.AUTONOMY_TRIT_SHADOW_TRUST_STATE_PATH)
  : path.join(repoRoot(), 'state', 'autonomy', 'trit_shadow_trust_state.json');
const INFLUENCE_BUDGET_PATH = process.env.AUTONOMY_TRIT_SHADOW_INFLUENCE_BUDGET_PATH
  ? path.resolve(process.env.AUTONOMY_TRIT_SHADOW_INFLUENCE_BUDGET_PATH)
  : path.join(repoRoot(), 'state', 'autonomy', 'trit_shadow_influence_budget.json');
const INFLUENCE_GUARD_PATH = process.env.AUTONOMY_TRIT_SHADOW_INFLUENCE_GUARD_PATH
  ? path.resolve(process.env.AUTONOMY_TRIT_SHADOW_INFLUENCE_GUARD_PATH)
  : path.join(repoRoot(), 'state', 'autonomy', 'trit_shadow_influence_guard.json');
const REPORT_HISTORY_PATH = process.env.AUTONOMY_TRIT_SHADOW_REPORT_HISTORY_PATH
  ? path.resolve(process.env.AUTONOMY_TRIT_SHADOW_REPORT_HISTORY_PATH)
  : path.join(repoRoot(), 'state', 'autonomy', 'trit_shadow_reports', 'history.jsonl');
const CALIBRATION_HISTORY_PATH = process.env.AUTONOMY_TRIT_SHADOW_CALIBRATION_HISTORY_PATH
  ? path.resolve(process.env.AUTONOMY_TRIT_SHADOW_CALIBRATION_HISTORY_PATH)
  : path.join(repoRoot(), 'state', 'autonomy', 'trit_shadow_calibration', 'history.jsonl');

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

function nowIso() {
  return new Date().toISOString();
}

function todayStr() {
  return nowIso().slice(0, 10);
}

function readJson(filePath: string, fallback: any) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function readJsonl(filePath: string) {
  if (!fs.existsSync(filePath)) return [];
  const out = [];
  const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
  for (const line of lines) {
    try {
      const row = JSON.parse(line);
      if (row && typeof row === 'object') out.push(row);
    } catch {
      // ignore malformed lines
    }
  }
  return out;
}

function writeJsonAtomic(filePath: string, value: AnyObj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function defaultTritShadowPolicy() {
  return {
    version: '1.0',
    enabled: true,
    semantics: {
      locked: true,
      neutral_on_missing: true,
      min_non_neutral_signals: 1,
      min_non_neutral_weight: 0.9,
      min_confidence_for_non_neutral: 0.3
    },
    trust: {
      enabled: true,
      default_source_trust: 1,
      source_trust_floor: 0.6,
      source_trust_ceiling: 1.5,
      freshness_half_life_hours: 72
    },
    influence: {
      stage: 0,
      min_confidence_stage2: 0.78,
      min_confidence_stage3: 0.85,
      max_overrides_per_day: 3,
      auto_disable_hours_on_regression: 24,
      auto_stage: {
        enabled: false,
        mode: 'floor',
        stage2: {
          consecutive_reports: 3,
          min_decisions: 20,
          max_divergence_rate: 0.08,
          min_calibration_events: 20,
          min_calibration_accuracy: 0.55,
          max_calibration_ece: 0.25,
          require_success_criteria_pass: false,
          require_safety_pass: true,
          require_drift_non_increasing: true
        },
        stage3: {
          consecutive_reports: 6,
          min_decisions: 40,
          max_divergence_rate: 0.05,
          min_calibration_events: 40,
          min_calibration_accuracy: 0.65,
          max_calibration_ece: 0.2,
          require_success_criteria_pass: true,
          require_safety_pass: true,
          require_drift_non_increasing: true
        }
      }
    },
    adaptation: {
      enabled: true,
      cadence_days: 7,
      min_samples_per_source: 6,
      reward_step: 0.04,
      penalty_step: 0.06,
      max_delta_per_cycle: 0.08
    }
  };
}

function normalizeTritShadowPolicy(input: AnyObj) {
  const src = input && typeof input === 'object' ? input : {};
  const base = defaultTritShadowPolicy();
  const semantics = src.semantics && typeof src.semantics === 'object' ? src.semantics : {};
  const trust = src.trust && typeof src.trust === 'object' ? src.trust : {};
  const influence = src.influence && typeof src.influence === 'object' ? src.influence : {};
  const autoStage = influence.auto_stage && typeof influence.auto_stage === 'object' ? influence.auto_stage : {};
  const autoStage2 = autoStage.stage2 && typeof autoStage.stage2 === 'object' ? autoStage.stage2 : {};
  const autoStage3 = autoStage.stage3 && typeof autoStage.stage3 === 'object' ? autoStage.stage3 : {};
  const adaptation = src.adaptation && typeof src.adaptation === 'object' ? src.adaptation : {};

  return {
    version: String(src.version || base.version),
    enabled: src.enabled !== false,
    semantics: {
      locked: semantics.locked !== false,
      neutral_on_missing: semantics.neutral_on_missing !== false,
      min_non_neutral_signals: clampInt(
        semantics.min_non_neutral_signals,
        0,
        1000,
        Number(base.semantics.min_non_neutral_signals)
      ),
      min_non_neutral_weight: clampNumber(
        semantics.min_non_neutral_weight,
        0,
        1000,
        Number(base.semantics.min_non_neutral_weight)
      ),
      min_confidence_for_non_neutral: clampNumber(
        semantics.min_confidence_for_non_neutral,
        0,
        1,
        Number(base.semantics.min_confidence_for_non_neutral)
      )
    },
    trust: {
      enabled: trust.enabled !== false,
      default_source_trust: clampNumber(
        trust.default_source_trust,
        0.01,
        5,
        Number(base.trust.default_source_trust)
      ),
      source_trust_floor: clampNumber(
        trust.source_trust_floor,
        0.01,
        5,
        Number(base.trust.source_trust_floor)
      ),
      source_trust_ceiling: clampNumber(
        trust.source_trust_ceiling,
        0.01,
        5,
        Number(base.trust.source_trust_ceiling)
      ),
      freshness_half_life_hours: clampNumber(
        trust.freshness_half_life_hours,
        1,
        24 * 365,
        Number(base.trust.freshness_half_life_hours)
      )
    },
    influence: {
      stage: clampInt(influence.stage, 0, 3, Number(base.influence.stage || 0)),
      min_confidence_stage2: clampNumber(
        influence.min_confidence_stage2,
        0,
        1,
        Number(base.influence.min_confidence_stage2)
      ),
      min_confidence_stage3: clampNumber(
        influence.min_confidence_stage3,
        0,
        1,
        Number(base.influence.min_confidence_stage3)
      ),
      max_overrides_per_day: clampInt(
        influence.max_overrides_per_day,
        0,
        10000,
        Number(base.influence.max_overrides_per_day)
      ),
      auto_disable_hours_on_regression: clampNumber(
        influence.auto_disable_hours_on_regression,
        1,
        24 * 30,
        Number(base.influence.auto_disable_hours_on_regression)
      ),
      auto_stage: {
        enabled: autoStage.enabled === true,
        mode: String(autoStage.mode || base.influence.auto_stage.mode || 'floor').toLowerCase() === 'override' ? 'override' : 'floor',
        stage2: {
          consecutive_reports: clampInt(
            autoStage2.consecutive_reports,
            1,
            365,
            Number(base.influence.auto_stage.stage2.consecutive_reports)
          ),
          min_decisions: clampInt(
            autoStage2.min_decisions,
            1,
            1000000,
            Number(base.influence.auto_stage.stage2.min_decisions)
          ),
          max_divergence_rate: clampNumber(
            autoStage2.max_divergence_rate,
            0,
            1,
            Number(base.influence.auto_stage.stage2.max_divergence_rate)
          ),
          min_calibration_events: clampInt(
            autoStage2.min_calibration_events,
            0,
            1000000,
            Number(base.influence.auto_stage.stage2.min_calibration_events)
          ),
          min_calibration_accuracy: clampNumber(
            autoStage2.min_calibration_accuracy,
            0,
            1,
            Number(base.influence.auto_stage.stage2.min_calibration_accuracy)
          ),
          max_calibration_ece: clampNumber(
            autoStage2.max_calibration_ece,
            0,
            1,
            Number(base.influence.auto_stage.stage2.max_calibration_ece)
          ),
          require_success_criteria_pass: autoStage2.require_success_criteria_pass === true,
          require_safety_pass: autoStage2.require_safety_pass !== false,
          require_drift_non_increasing: autoStage2.require_drift_non_increasing !== false
        },
        stage3: {
          consecutive_reports: clampInt(
            autoStage3.consecutive_reports,
            1,
            365,
            Number(base.influence.auto_stage.stage3.consecutive_reports)
          ),
          min_decisions: clampInt(
            autoStage3.min_decisions,
            1,
            1000000,
            Number(base.influence.auto_stage.stage3.min_decisions)
          ),
          max_divergence_rate: clampNumber(
            autoStage3.max_divergence_rate,
            0,
            1,
            Number(base.influence.auto_stage.stage3.max_divergence_rate)
          ),
          min_calibration_events: clampInt(
            autoStage3.min_calibration_events,
            0,
            1000000,
            Number(base.influence.auto_stage.stage3.min_calibration_events)
          ),
          min_calibration_accuracy: clampNumber(
            autoStage3.min_calibration_accuracy,
            0,
            1,
            Number(base.influence.auto_stage.stage3.min_calibration_accuracy)
          ),
          max_calibration_ece: clampNumber(
            autoStage3.max_calibration_ece,
            0,
            1,
            Number(base.influence.auto_stage.stage3.max_calibration_ece)
          ),
          require_success_criteria_pass: autoStage3.require_success_criteria_pass !== false,
          require_safety_pass: autoStage3.require_safety_pass !== false,
          require_drift_non_increasing: autoStage3.require_drift_non_increasing !== false
        }
      }
    },
    adaptation: {
      enabled: adaptation.enabled !== false,
      cadence_days: clampInt(adaptation.cadence_days, 1, 60, Number(base.adaptation.cadence_days)),
      min_samples_per_source: clampInt(
        adaptation.min_samples_per_source,
        1,
        10000,
        Number(base.adaptation.min_samples_per_source)
      ),
      reward_step: clampNumber(adaptation.reward_step, 0, 1, Number(base.adaptation.reward_step)),
      penalty_step: clampNumber(adaptation.penalty_step, 0, 1, Number(base.adaptation.penalty_step)),
      max_delta_per_cycle: clampNumber(
        adaptation.max_delta_per_cycle,
        0,
        1,
        Number(base.adaptation.max_delta_per_cycle)
      )
    }
  };
}

function loadTritShadowPolicy(filePath = POLICY_PATH) {
  return normalizeTritShadowPolicy(readJson(filePath, null));
}

function loadTritShadowSuccessCriteria(filePath = SUCCESS_CRITERIA_PATH) {
  return readJson(filePath, {
    version: '1.0',
    targets: {
      max_divergence_rate: 0.05,
      min_decisions_for_divergence: 30,
      max_safety_regressions: 0,
      drift_non_increasing: true,
      min_yield_lift: 0.03
    },
    baseline: {
      drift_rate: 0.03,
      yield_rate: 0.714
    }
  });
}

function defaultTrustState(policy: AnyObj) {
  return {
    schema_id: 'trit_shadow_trust_state',
    schema_version: '1.0.0',
    updated_at: null,
    default_source_trust: Number(policy && policy.trust && policy.trust.default_source_trust || 1),
    by_source: {}
  };
}

function normalizeTrustState(input: AnyObj, policy: AnyObj) {
  const base = defaultTrustState(policy);
  const src = input && typeof input === 'object' ? input : {};
  const bySourceSrc = src.by_source && typeof src.by_source === 'object' ? src.by_source : {};
  const bySource: AnyObj = {};
  const floor = Number(policy && policy.trust && policy.trust.source_trust_floor || 0.6);
  const ceiling = Number(policy && policy.trust && policy.trust.source_trust_ceiling || 1.5);
  for (const [source, row] of Object.entries(bySourceSrc)) {
    const rec = row && typeof row === 'object' ? row : {};
    bySource[source] = {
      trust: clampNumber(rec.trust, floor, ceiling, Number(base.default_source_trust || 1)),
      samples: Math.max(0, Math.floor(Number(rec.samples || 0))),
      hit_rate: clampNumber(rec.hit_rate, 0, 1, 0),
      updated_at: rec.updated_at ? String(rec.updated_at) : null
    };
  }
  return {
    ...base,
    ...src,
    default_source_trust: clampNumber(
      src.default_source_trust,
      floor,
      ceiling,
      Number(base.default_source_trust || 1)
    ),
    by_source: bySource
  };
}

function loadTritShadowTrustState(policy = loadTritShadowPolicy(), filePath = TRUST_STATE_PATH) {
  return normalizeTrustState(readJson(filePath, null), policy);
}

function saveTritShadowTrustState(state: AnyObj, filePath = TRUST_STATE_PATH) {
  const next = state && typeof state === 'object' ? state : {};
  writeJsonAtomic(filePath, {
    ...next,
    updated_at: nowIso()
  });
}

function buildTritSourceTrustMap(trustState: AnyObj) {
  const state = trustState && typeof trustState === 'object' ? trustState : {};
  const by = state.by_source && typeof state.by_source === 'object' ? state.by_source : {};
  const out: AnyObj = {};
  for (const [source, row] of Object.entries(by)) {
    const rec = row && typeof row === 'object' ? row : {};
    out[source] = Number(rec.trust || 1);
  }
  return out;
}

function resolveTritShadowStage(policy: AnyObj) {
  const decision = resolveTritShadowStageDecision(policy);
  return Number(decision && decision.stage || 0);
}

function latestCalibration() {
  const rows = readJsonl(CALIBRATION_HISTORY_PATH)
    .filter((row) => row && typeof row === 'object')
    .sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')));
  if (!rows.length) return null;
  return rows[rows.length - 1];
}

function reportPassesAutoStage(row: AnyObj, cfg: AnyObj) {
  const report = row && typeof row === 'object' ? row : {};
  const summary = report.summary && typeof report.summary === 'object' ? report.summary : {};
  const success = report.success_criteria && typeof report.success_criteria === 'object' ? report.success_criteria : {};
  const checks = success.checks && typeof success.checks === 'object' ? success.checks : {};
  if (Number(summary.total_decisions || 0) < Number(cfg.min_decisions || 0)) return false;
  if (Number(summary.divergence_rate || 0) > Number(cfg.max_divergence_rate || 1)) return false;
  if (cfg.require_success_criteria_pass === true && success.pass !== true) return false;
  if (cfg.require_safety_pass === true) {
    const safety = checks.safety_regressions && typeof checks.safety_regressions === 'object'
      ? checks.safety_regressions
      : {};
    if (safety.pass !== true) return false;
  }
  if (cfg.require_drift_non_increasing === true) {
    const drift = checks.drift_non_increasing && typeof checks.drift_non_increasing === 'object'
      ? checks.drift_non_increasing
      : {};
    if (drift.pass !== true) return false;
  }
  return true;
}

function calibrationPassesAutoStage(calibration: AnyObj, cfg: AnyObj) {
  if (!cfg || typeof cfg !== 'object') return false;
  if (!calibration || typeof calibration !== 'object') return false;
  const summary = calibration.summary && typeof calibration.summary === 'object' ? calibration.summary : {};
  if (Number(summary.total_events || 0) < Number(cfg.min_calibration_events || 0)) return false;
  if (Number(summary.accuracy || 0) < Number(cfg.min_calibration_accuracy || 0)) return false;
  if (Number(summary.expected_calibration_error || 1) > Number(cfg.max_calibration_ece || 1)) return false;
  return true;
}

function evaluateAutoStage(policy: AnyObj) {
  const p = policy && typeof policy === 'object' ? policy : loadTritShadowPolicy();
  const autoCfg = p && p.influence && p.influence.auto_stage && typeof p.influence.auto_stage === 'object'
    ? p.influence.auto_stage
    : {};
  if (autoCfg.enabled !== true) {
    return {
      enabled: false,
      stage: 0,
      reason: 'auto_stage_disabled',
      report_rows_evaluated: 0
    };
  }
  const reports = readJsonl(REPORT_HISTORY_PATH)
    .filter((row) => row && typeof row === 'object' && row.type === 'trit_shadow_report' && row.ok === true)
    .sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')));
  const calibration = latestCalibration();
  const stage3Cfg = autoCfg.stage3 && typeof autoCfg.stage3 === 'object' ? autoCfg.stage3 : {};
  const stage2Cfg = autoCfg.stage2 && typeof autoCfg.stage2 === 'object' ? autoCfg.stage2 : {};
  const stage3Window = Math.max(1, Number(stage3Cfg.consecutive_reports || 6));
  const stage2Window = Math.max(1, Number(stage2Cfg.consecutive_reports || 3));
  const recent3 = reports.slice(-stage3Window);
  const recent2 = reports.slice(-stage2Window);

  const stage3ReportsPass = recent3.length >= stage3Window && recent3.every((row) => reportPassesAutoStage(row, stage3Cfg));
  const stage2ReportsPass = recent2.length >= stage2Window && recent2.every((row) => reportPassesAutoStage(row, stage2Cfg));
  const stage3CalibrationPass = calibrationPassesAutoStage(calibration, stage3Cfg);
  const stage2CalibrationPass = calibrationPassesAutoStage(calibration, stage2Cfg);

  if (stage3ReportsPass && stage3CalibrationPass) {
    return {
      enabled: true,
      stage: 3,
      reason: 'auto_stage3_threshold_met',
      report_rows_evaluated: recent3.length,
      calibration_date: calibration && calibration.date ? String(calibration.date) : null
    };
  }
  if (stage2ReportsPass && stage2CalibrationPass) {
    return {
      enabled: true,
      stage: 2,
      reason: 'auto_stage2_threshold_met',
      report_rows_evaluated: recent2.length,
      calibration_date: calibration && calibration.date ? String(calibration.date) : null
    };
  }
  return {
    enabled: true,
    stage: 0,
    reason: 'auto_thresholds_not_met',
    report_rows_evaluated: reports.length,
    calibration_date: calibration && calibration.date ? String(calibration.date) : null
  };
}

function resolveTritShadowStageDecision(policy: AnyObj) {
  const src = policy && policy.influence && typeof policy.influence === 'object' ? policy.influence : {};
  const baseStage = clampInt(src.stage, 0, 3, 0);
  const env = process.env.AUTONOMY_TRIT_SHADOW_STAGE;
  if (env != null && String(env).trim() !== '') {
    const n = Number(env);
    if (Number.isFinite(n)) {
      return { stage: clampInt(n, 0, 3, 0), source: 'env_numeric', base_stage: baseStage, auto_stage: null };
    }
    const t = String(env).trim().toLowerCase();
    if (t === 'shadow_only') return { stage: 0, source: 'env_label', base_stage: baseStage, auto_stage: null };
    if (t === 'advisory') return { stage: 1, source: 'env_label', base_stage: baseStage, auto_stage: null };
    if (t === 'influence_limited') return { stage: 2, source: 'env_label', base_stage: baseStage, auto_stage: null };
    if (t === 'influence_budgeted') return { stage: 3, source: 'env_label', base_stage: baseStage, auto_stage: null };
  }
  const auto = evaluateAutoStage(policy);
  if (auto.enabled === true) {
    const mode = src.auto_stage && String(src.auto_stage.mode || 'floor').toLowerCase() === 'override'
      ? 'override'
      : 'floor';
    const stage = mode === 'override'
      ? clampInt(auto.stage, 0, 3, 0)
      : Math.max(baseStage, clampInt(auto.stage, 0, 3, 0));
    return {
      stage,
      source: `auto_${mode}`,
      base_stage: baseStage,
      auto_stage: auto
    };
  }
  return {
    stage: baseStage,
    source: 'policy',
    base_stage: baseStage,
    auto_stage: auto
  };
}

function defaultInfluenceBudget() {
  return {
    schema_id: 'trit_shadow_influence_budget',
    schema_version: '1.0.0',
    by_date: {},
    updated_at: null
  };
}

function loadTritShadowInfluenceBudget(filePath = INFLUENCE_BUDGET_PATH) {
  const src = readJson(filePath, null);
  const base = defaultInfluenceBudget();
  const byDateSrc = src && src.by_date && typeof src.by_date === 'object' ? src.by_date : {};
  const byDate: AnyObj = {};
  for (const [date, row] of Object.entries(byDateSrc)) {
    const rec = row && typeof row === 'object' ? row : {};
    byDate[date] = {
      overrides: Math.max(0, Math.floor(Number(rec.overrides || 0))),
      by_source: rec.by_source && typeof rec.by_source === 'object' ? rec.by_source : {}
    };
  }
  return {
    ...base,
    ...(src && typeof src === 'object' ? src : {}),
    by_date: byDate
  };
}

function saveTritShadowInfluenceBudget(budget: AnyObj, filePath = INFLUENCE_BUDGET_PATH) {
  const next = budget && typeof budget === 'object' ? budget : defaultInfluenceBudget();
  writeJsonAtomic(filePath, {
    ...next,
    updated_at: nowIso()
  });
}

function canConsumeTritShadowOverride(
  policy: AnyObj,
  dateStr = todayStr(),
  filePath = INFLUENCE_BUDGET_PATH
) {
  const p = policy && typeof policy === 'object' ? policy : loadTritShadowPolicy();
  const maxPerDay = Math.max(0, Number(p && p.influence && p.influence.max_overrides_per_day || 0));
  if (maxPerDay <= 0) return { allowed: false, reason: 'budget_disabled', remaining: 0 };
  const budget = loadTritShadowInfluenceBudget(filePath);
  const row = budget.by_date && budget.by_date[dateStr] && typeof budget.by_date[dateStr] === 'object'
    ? budget.by_date[dateStr]
    : { overrides: 0 };
  const used = Math.max(0, Number(row.overrides || 0));
  const remaining = Math.max(0, maxPerDay - used);
  if (remaining <= 0) {
    return { allowed: false, reason: 'daily_override_budget_exhausted', remaining: 0, used, max_per_day: maxPerDay };
  }
  return { allowed: true, reason: 'ok', remaining, used, max_per_day: maxPerDay };
}

function consumeTritShadowOverride(
  source: string,
  policy: AnyObj,
  dateStr = todayStr(),
  filePath = INFLUENCE_BUDGET_PATH
) {
  const check = canConsumeTritShadowOverride(policy, dateStr, filePath);
  if (!check.allowed) return { ...check, consumed: false };
  const budget = loadTritShadowInfluenceBudget(filePath);
  budget.by_date = budget.by_date && typeof budget.by_date === 'object' ? budget.by_date : {};
  const row = budget.by_date[dateStr] && typeof budget.by_date[dateStr] === 'object'
    ? budget.by_date[dateStr]
    : { overrides: 0, by_source: {} };
  row.overrides = Math.max(0, Number(row.overrides || 0)) + 1;
  row.by_source = row.by_source && typeof row.by_source === 'object' ? row.by_source : {};
  const src = String(source || 'unknown').trim() || 'unknown';
  row.by_source[src] = Math.max(0, Number(row.by_source[src] || 0)) + 1;
  budget.by_date[dateStr] = row;
  saveTritShadowInfluenceBudget(budget, filePath);
  return {
    consumed: true,
    allowed: true,
    reason: 'ok',
    remaining: Math.max(0, Number(check.remaining || 0) - 1),
    used: row.overrides,
    max_per_day: check.max_per_day
  };
}

function defaultInfluenceGuard() {
  return {
    schema_id: 'trit_shadow_influence_guard',
    schema_version: '1.0.0',
    disabled: false,
    reason: null,
    disabled_until: null,
    last_report_ts: null,
    updated_at: null
  };
}

function loadTritShadowInfluenceGuard(filePath = INFLUENCE_GUARD_PATH) {
  const raw = readJson(filePath, null);
  const base = defaultInfluenceGuard();
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    ...base,
    ...src,
    disabled: src.disabled === true,
    reason: src.reason ? String(src.reason) : null,
    disabled_until: src.disabled_until ? String(src.disabled_until) : null,
    last_report_ts: src.last_report_ts ? String(src.last_report_ts) : null
  };
}

function saveTritShadowInfluenceGuard(guard: AnyObj, filePath = INFLUENCE_GUARD_PATH) {
  const next = guard && typeof guard === 'object' ? guard : defaultInfluenceGuard();
  writeJsonAtomic(filePath, {
    ...next,
    updated_at: nowIso()
  });
}

function isTritShadowInfluenceBlocked(guard: AnyObj, nowTs?: string) {
  const g = guard && typeof guard === 'object' ? guard : defaultInfluenceGuard();
  if (g.disabled !== true) return { blocked: false, reason: 'enabled' };
  const nowMs = Date.parse(String(nowTs || nowIso()));
  const untilMs = Date.parse(String(g.disabled_until || ''));
  if (Number.isFinite(nowMs) && Number.isFinite(untilMs) && nowMs > untilMs) {
    return { blocked: false, reason: 'expired' };
  }
  return {
    blocked: true,
    reason: String(g.reason || 'disabled'),
    disabled_until: g.disabled_until || null
  };
}

function applyInfluenceGuardFromShadowReport(
  reportPayload: AnyObj,
  policy: AnyObj = loadTritShadowPolicy(),
  filePath = INFLUENCE_GUARD_PATH
) {
  const payload = reportPayload && typeof reportPayload === 'object' ? reportPayload : {};
  const summary = payload.summary && typeof payload.summary === 'object' ? payload.summary : {};
  const gate = summary.gate && typeof summary.gate === 'object' ? summary.gate : {};
  const status = String(summary.status || '').trim().toLowerCase();
  const shouldDisable = gate.enabled === true
    ? gate.pass === false
    : status === 'critical';
  const prev = loadTritShadowInfluenceGuard(filePath);
  const next = { ...prev };
  const disableHours = Math.max(1, Number(policy && policy.influence && policy.influence.auto_disable_hours_on_regression || 24));

  if (shouldDisable) {
    next.disabled = true;
    next.reason = gate.enabled === true && gate.pass === false
      ? `shadow_gate_failed:${String(gate.reason || 'divergence_rate_exceeds_limit')}`
      : 'shadow_status_critical';
    next.disabled_until = new Date(Date.now() + disableHours * 60 * 60 * 1000).toISOString();
  } else {
    next.disabled = false;
    next.reason = null;
    next.disabled_until = null;
  }
  next.last_report_ts = payload.ts ? String(payload.ts) : nowIso();
  saveTritShadowInfluenceGuard(next, filePath);
  return next;
}

module.exports = {
  defaultTritShadowPolicy,
  normalizeTritShadowPolicy,
  loadTritShadowPolicy,
  loadTritShadowSuccessCriteria,
  loadTritShadowTrustState,
  saveTritShadowTrustState,
  buildTritSourceTrustMap,
  evaluateAutoStage,
  resolveTritShadowStageDecision,
  resolveTritShadowStage,
  canConsumeTritShadowOverride,
  consumeTritShadowOverride,
  loadTritShadowInfluenceGuard,
  saveTritShadowInfluenceGuard,
  isTritShadowInfluenceBlocked,
  applyInfluenceGuardFromShadowReport,
  paths: {
    policy: POLICY_PATH,
    success_criteria: SUCCESS_CRITERIA_PATH,
    report_history: REPORT_HISTORY_PATH,
    calibration_history: CALIBRATION_HISTORY_PATH,
    trust_state: TRUST_STATE_PATH,
    influence_budget: INFLUENCE_BUDGET_PATH,
    influence_guard: INFLUENCE_GUARD_PATH
  }
};
