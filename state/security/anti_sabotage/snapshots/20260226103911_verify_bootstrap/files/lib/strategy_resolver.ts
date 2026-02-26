'use strict';
export {};

const fs = require('fs');
const path = require('path');
const { loadOutcomeFitnessPolicy } = require('./outcome_fitness');

type AnyObj = Record<string, any>;

const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_STRATEGY_DIR = path.join(REPO_ROOT, 'config', 'strategies');
const THRESHOLD_KEYS = new Set([
  'min_signal_quality',
  'min_sensory_signal_score',
  'min_sensory_relevance_score',
  'min_directive_fit',
  'min_actionability_score',
  'min_eye_score_ema',
  'min_composite_eligibility'
]);
const VALID_RISK_LEVELS = new Set(['low', 'medium', 'high']);
const ALLOWED_TOP_KEYS = new Set([
  'version',
  'id',
  'name',
  'status',
  'tags',
  'objective',
  'campaigns',
  'generation_policy',
  'risk_policy',
  'allowed_risks',
  'admission_policy',
  'ranking_weights',
  'budget_policy',
  'exploration_policy',
  'stop_policy',
  'promotion_policy',
  'execution_policy',
  'threshold_overrides',
  'value_currency_policy'
]);
const STRATEGY_GENERATION_MODES = new Set([
  'normal',
  'narrative',
  'creative',
  'hyper-creative',
  'deep-thinker'
]);
const VALUE_CURRENCY_KEYS = new Set([
  'revenue',
  'delivery',
  'user_value',
  'quality',
  'time_savings',
  'learning'
]);

function asString(v) {
  return String(v == null ? '' : v).trim();
}

function asStringArray(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const item of v) {
    const s = asString(item);
    if (s) out.push(s);
  }
  return Array.from(new Set(out));
}

function normalizeValueCurrencyToken(v) {
  const key = asString(v).toLowerCase();
  if (!VALUE_CURRENCY_KEYS.has(key)) return '';
  return key;
}

function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function normalizeThresholdOverrides(raw) {
  const out = {};
  const src = raw && typeof raw === 'object' ? raw : {};
  for (const [key, value] of Object.entries(src)) {
    if (!THRESHOLD_KEYS.has(key)) continue;
    const n = Number(value);
    if (!Number.isFinite(n)) continue;
    out[key] = n;
  }
  return out;
}

function normalizeRiskPolicy(rawRisk, rawAllowed, warnings) {
  const riskSrc = rawRisk && typeof rawRisk === 'object' ? rawRisk : {};
  const fromRisk = rawRisk && typeof rawRisk === 'object'
    ? asStringArray(rawRisk.allowed_risks).map(x => x.toLowerCase())
    : [];
  const fromRoot = asStringArray(rawAllowed).map(x => x.toLowerCase());
  const combined = Array.from(new Set([...fromRisk, ...fromRoot]));
  const invalid = combined.filter(x => !VALID_RISK_LEVELS.has(x));
  const allowed = combined.filter(x => VALID_RISK_LEVELS.has(x));
  if (invalid.length && Array.isArray(warnings)) {
    for (const item of invalid) warnings.push(`risk_policy_invalid_risk_filtered:${item}`);
  }
  const maxPerAction = Number(riskSrc.max_risk_per_action);
  const max_risk_per_action = Number.isFinite(maxPerAction)
    ? Math.max(0, Math.min(100, Math.round(maxPerAction)))
    : null;
  return { allowed_risks: allowed, max_risk_per_action, invalid_risks: invalid };
}

function normalizeStatus(raw) {
  const s = asString(raw).toLowerCase();
  if (s === 'disabled' || s === 'off' || s === 'paused') return 'disabled';
  return 'active';
}

function clampNumber(v, lo, hi, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function normalizeInteger(v, lo, hi, fallback, allowNull = false) {
  if (allowNull && (v == null || String(v).trim() === '')) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const x = Math.round(n);
  if (x < lo) return lo;
  if (x > hi) return hi;
  return x;
}

function normalizeAdmissionPolicy(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    allowed_types: asStringArray(src.allowed_types).map(x => x.toLowerCase()),
    blocked_types: asStringArray(src.blocked_types).map(x => x.toLowerCase()),
    max_remediation_depth: normalizeInteger(src.max_remediation_depth, 0, 12, null, true),
    duplicate_window_hours: normalizeInteger(src.duplicate_window_hours, 1, 168, 24)
  };
}

function normalizeRankingWeights(raw, errors) {
  const defaults = {
    composite: 0.35,
    actionability: 0.2,
    directive_fit: 0.15,
    signal_quality: 0.15,
    expected_value: 0.1,
    time_to_value: 0,
    risk_penalty: 0.05
  };
  const src = raw && typeof raw === 'object' ? raw : {};
  const merged = { ...defaults };
  for (const [key, val] of Object.entries(src)) {
    if (!(key in defaults)) continue;
    const n = Number(val);
    if (!Number.isFinite(n) || n < 0) continue;
    merged[key] = n;
  }
  const total = Object.values(merged).reduce((a, b) => a + Number(b || 0), 0);
  if (total <= 0) {
    errors.push('ranking_weights_sum_zero');
    return defaults;
  }
  const normalized = {};
  for (const [k, v] of Object.entries(merged)) {
    normalized[k] = Number((Number(v) / total).toFixed(6));
  }
  return normalized;
}

function normalizeValueCurrencyPolicy(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const objectiveSrc = src.objective_overrides && typeof src.objective_overrides === 'object'
    ? src.objective_overrides
    : {};
  const currencySrc = src.currency_overrides && typeof src.currency_overrides === 'object'
    ? src.currency_overrides
    : {};
  const objectiveOverrides = {};
  const currencyOverrides = {};
  for (const [objectiveIdRaw, row] of Object.entries(objectiveSrc)) {
    const objectiveId = asString(objectiveIdRaw);
    if (!objectiveId) continue;
    const payload = row && typeof row === 'object' ? row as AnyObj : {} as AnyObj;
    const ranking = payload.ranking_weights && typeof payload.ranking_weights === 'object'
      ? mergeRankingWeights({}, payload.ranking_weights)
      : null;
    const primaryCurrency = normalizeValueCurrencyToken(payload.primary_currency);
    if (!ranking && !primaryCurrency) continue;
    objectiveOverrides[objectiveId] = {
      primary_currency: primaryCurrency || null,
      ranking_weights: ranking || null
    };
  }
  for (const [currencyRaw, row] of Object.entries(currencySrc)) {
    const currency = normalizeValueCurrencyToken(currencyRaw);
    if (!currency) continue;
    const payload = row && typeof row === 'object' ? row as AnyObj : {} as AnyObj;
    const ranking = payload.ranking_weights && typeof payload.ranking_weights === 'object'
      ? mergeRankingWeights({}, payload.ranking_weights)
      : mergeRankingWeights({}, payload);
    currencyOverrides[currency] = {
      ranking_weights: ranking
    };
  }
  const defaultCurrency = normalizeValueCurrencyToken(src.default_currency);
  return {
    default_currency: defaultCurrency || null,
    objective_overrides: objectiveOverrides,
    currency_overrides: currencyOverrides
  };
}

function mergeRankingWeights(base, overlay) {
  const merged = { ...(base && typeof base === 'object' ? base : {}) };
  const src = overlay && typeof overlay === 'object' ? overlay : {};
  for (const [key, value] of Object.entries(src)) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) continue;
    merged[key] = n;
  }
  return normalizeRankingWeights(merged, []);
}

function mergeValueCurrencyPolicy(baseRaw, overlayRaw) {
  const base = normalizeValueCurrencyPolicy(baseRaw);
  const overlay = normalizeValueCurrencyPolicy(overlayRaw);

  const objectiveOverrides = { ...(base.objective_overrides || {}) };
  for (const [objectiveId, rowRaw] of Object.entries(overlay.objective_overrides || {})) {
    const row = rowRaw && typeof rowRaw === 'object' ? rowRaw as AnyObj : {} as AnyObj;
    const prev = objectiveOverrides[objectiveId] && typeof objectiveOverrides[objectiveId] === 'object'
      ? objectiveOverrides[objectiveId] as AnyObj
      : {} as AnyObj;
    objectiveOverrides[objectiveId] = {
      primary_currency: normalizeValueCurrencyToken(row.primary_currency) || normalizeValueCurrencyToken(prev.primary_currency) || null,
      ranking_weights: row.ranking_weights && typeof row.ranking_weights === 'object'
        ? mergeRankingWeights(prev.ranking_weights, row.ranking_weights)
        : (prev.ranking_weights && typeof prev.ranking_weights === 'object' ? prev.ranking_weights : null)
    };
  }

  const currencyOverrides = { ...(base.currency_overrides || {}) };
  for (const [currency, rowRaw] of Object.entries(overlay.currency_overrides || {})) {
    const row = rowRaw && typeof rowRaw === 'object' ? rowRaw as AnyObj : {} as AnyObj;
    const prev = currencyOverrides[currency] && typeof currencyOverrides[currency] === 'object'
      ? currencyOverrides[currency] as AnyObj
      : {} as AnyObj;
    const nextRanking = row.ranking_weights && typeof row.ranking_weights === 'object'
      ? mergeRankingWeights(prev.ranking_weights, row.ranking_weights)
      : (prev.ranking_weights && typeof prev.ranking_weights === 'object' ? prev.ranking_weights : null);
    if (!nextRanking) continue;
    currencyOverrides[currency] = { ranking_weights: nextRanking };
  }

  const defaultCurrency = normalizeValueCurrencyToken(overlay.default_currency)
    || normalizeValueCurrencyToken(base.default_currency)
    || null;

  return {
    default_currency: defaultCurrency,
    objective_overrides: objectiveOverrides,
    currency_overrides: currencyOverrides
  };
}

function applyOutcomeFitnessOverlay(strategy) {
  if (!strategy || typeof strategy !== 'object') return strategy;
  const policy = loadOutcomeFitnessPolicy(REPO_ROOT);
  if (!policy || !policy.found) return strategy;
  const strategyPolicy = policy.strategy_policy || {};
  const strategyId = String(strategyPolicy.strategy_id || '').trim();
  if (strategyId && strategyId !== String(strategy.id || '') && strategyId !== '*') {
    return strategy;
  }

  const thresholdOverlay = strategyPolicy.threshold_overrides && typeof strategyPolicy.threshold_overrides === 'object'
    ? strategyPolicy.threshold_overrides
    : {};
  const rankingOverlay = strategyPolicy.ranking_weights_override && typeof strategyPolicy.ranking_weights_override === 'object'
    ? strategyPolicy.ranking_weights_override
    : null;
  const promotionOverlay = strategyPolicy.promotion_policy_overrides && typeof strategyPolicy.promotion_policy_overrides === 'object'
    ? strategyPolicy.promotion_policy_overrides
    : null;
  const valueCurrencyOverlay = strategyPolicy.value_currency_policy_overrides && typeof strategyPolicy.value_currency_policy_overrides === 'object'
    ? strategyPolicy.value_currency_policy_overrides
    : null;

  const next = {
    ...strategy,
    threshold_overrides: normalizeThresholdOverrides({
      ...(strategy.threshold_overrides || {}),
      ...thresholdOverlay
    })
  };

  if (rankingOverlay && Object.keys(rankingOverlay).length > 0) {
    next.ranking_weights = mergeRankingWeights(strategy.ranking_weights, rankingOverlay);
  }
  if (promotionOverlay && Object.keys(promotionOverlay).length > 0) {
    next.promotion_policy = normalizePromotionPolicy({
      ...(strategy.promotion_policy && typeof strategy.promotion_policy === 'object' ? strategy.promotion_policy : {}),
      ...promotionOverlay
    });
  }
  if (valueCurrencyOverlay && Object.keys(valueCurrencyOverlay).length > 0) {
    next.value_currency_policy = mergeValueCurrencyPolicy(strategy.value_currency_policy, valueCurrencyOverlay);
  }

  next.outcome_fitness_policy = {
    ts: policy.ts || null,
    realized_outcome_score: policy.realized_outcome_score,
    source: path.relative(REPO_ROOT, policy.path).replace(/\\/g, '/')
  };
  return next;
}

function normalizeBudgetPolicy(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const caps = src.per_capability_caps && typeof src.per_capability_caps === 'object'
    ? src.per_capability_caps
    : {};
  const perCaps = {};
  for (const [k, v] of Object.entries(caps)) {
    const key = asString(k).toLowerCase();
    if (!key) continue;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) continue;
    perCaps[key] = Math.round(n);
  }
  const tokenCostPer1k = Number(src.token_cost_per_1k);
  const dailyUsdCap = Number(src.daily_usd_cap);
  const perActionAvgUsdCap = Number(src.per_action_avg_usd_cap);
  const monthlyUsdAllocation = Number(src.monthly_usd_allocation);
  const monthlyCreditsFloorPct = Number(src.monthly_credits_floor_pct);
  const minProjectedTokensForBurnCheck = Number(src.min_projected_tokens_for_burn_check);
  return {
    daily_runs_cap: normalizeInteger(src.daily_runs_cap, 1, 500, null, true),
    daily_token_cap: normalizeInteger(src.daily_token_cap, 100, 1000000, null, true),
    max_tokens_per_action: normalizeInteger(src.max_tokens_per_action, 50, 1000000, null, true),
    token_cost_per_1k: Number.isFinite(tokenCostPer1k) && tokenCostPer1k > 0
      ? Number(tokenCostPer1k)
      : null,
    daily_usd_cap: Number.isFinite(dailyUsdCap) && dailyUsdCap > 0
      ? Number(dailyUsdCap)
      : null,
    per_action_avg_usd_cap: Number.isFinite(perActionAvgUsdCap) && perActionAvgUsdCap > 0
      ? Number(perActionAvgUsdCap)
      : null,
    monthly_usd_allocation: Number.isFinite(monthlyUsdAllocation) && monthlyUsdAllocation > 0
      ? Number(monthlyUsdAllocation)
      : null,
    monthly_credits_floor_pct: Number.isFinite(monthlyCreditsFloorPct)
      ? Number(clampNumber(monthlyCreditsFloorPct, 0, 0.95, 0.2).toFixed(4))
      : null,
    min_projected_tokens_for_burn_check: Number.isFinite(minProjectedTokensForBurnCheck) && minProjectedTokensForBurnCheck >= 0
      ? Math.round(minProjectedTokensForBurnCheck)
      : null,
    per_capability_caps: perCaps
  };
}

function normalizeExplorationPolicy(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    fraction: Number(clampNumber(src.fraction, 0.05, 0.8, 0.25).toFixed(3)),
    every_n: normalizeInteger(src.every_n, 1, 20, 3),
    min_eligible: normalizeInteger(src.min_eligible, 2, 20, 3)
  };
}

function normalizeStopPolicy(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const cb = src.circuit_breakers && typeof src.circuit_breakers === 'object' ? src.circuit_breakers : {};
  const rc = src.recursion && typeof src.recursion === 'object' ? src.recursion : {};
  return {
    circuit_breakers: {
      http_429_cooldown_hours: normalizeInteger(cb.http_429_cooldown_hours, 1, 168, 12),
      http_5xx_cooldown_hours: normalizeInteger(cb.http_5xx_cooldown_hours, 1, 168, 6),
      dns_error_cooldown_hours: normalizeInteger(cb.dns_error_cooldown_hours, 1, 168, 6)
    },
    recursion: {
      max_consecutive_remediation: normalizeInteger(rc.max_consecutive_remediation, 0, 12, 2),
      max_duplicate_proposals_24h: normalizeInteger(rc.max_duplicate_proposals_24h, 1, 200, 3)
    }
  };
}

function normalizePromotionPolicy(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    min_days: normalizeInteger(src.min_days, 1, 90, 7),
    min_attempted: normalizeInteger(src.min_attempted, 0, 10000, 12),
    min_verified_rate: Number(clampNumber(src.min_verified_rate, 0, 1, 0.5).toFixed(3)),
    min_success_criteria_receipts: normalizeInteger(src.min_success_criteria_receipts, 0, 10000, 2),
    min_success_criteria_pass_rate: Number(clampNumber(src.min_success_criteria_pass_rate, 0, 1, 0.6).toFixed(3)),
    min_objective_coverage: Number(clampNumber(src.min_objective_coverage, 0, 1, 0.25).toFixed(3)),
    max_objective_no_progress_rate: Number(clampNumber(src.max_objective_no_progress_rate, 0, 1, 0.9).toFixed(3)),
    max_reverted_rate: Number(clampNumber(src.max_reverted_rate, 0, 1, 0.35).toFixed(3)),
    max_stop_ratio: Number(clampNumber(src.max_stop_ratio, 0, 1, 0.75).toFixed(3)),
    min_shipped: normalizeInteger(src.min_shipped, 0, 10000, 1),
    disable_legacy_fallback_after_quality_receipts: normalizeInteger(
      src.disable_legacy_fallback_after_quality_receipts,
      0,
      10000,
      10
    ),
    max_success_criteria_quality_insufficient_rate: Number(
      clampNumber(src.max_success_criteria_quality_insufficient_rate, 0, 1, 0.4).toFixed(3)
    )
  };
}

function normalizeExecutionPolicy(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const modeRaw = asString(src.mode).toLowerCase();
  const mode = modeRaw === 'execute'
    ? 'execute'
    : (modeRaw === 'canary_execute' ? 'canary_execute' : 'score_only');
  return {
    mode,
    canary_daily_exec_limit: normalizeInteger(src.canary_daily_exec_limit, 1, 20, null, true)
  };
}

function normalizeGenerationPolicy(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const modeRaw = asString(src.mode).toLowerCase();
  const mode = STRATEGY_GENERATION_MODES.has(modeRaw) ? modeRaw : 'hyper-creative';
  return { mode };
}

function normalizeObjective(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    primary: asString(src.primary),
    secondary: asStringArray(src.secondary),
    fitness_metric: asString(src.fitness_metric) || 'verified_progress_rate',
    target_window_days: normalizeInteger(src.target_window_days, 1, 90, 14)
  };
}

function pushValidationChecks(normalized, warnings, errors) {
  if (!normalized || typeof normalized !== 'object') return;

  const allowedTypes = Array.isArray(normalized.admission_policy && normalized.admission_policy.allowed_types)
    ? normalized.admission_policy.allowed_types
    : [];
  const blockedTypes = Array.isArray(normalized.admission_policy && normalized.admission_policy.blocked_types)
    ? normalized.admission_policy.blocked_types
    : [];
  const blockedSet = new Set(blockedTypes);
  for (const t of allowedTypes) {
    if (blockedSet.has(t)) errors.push(`admission_policy_type_conflict:${t}`);
  }

  const duplicateWindow = Number(normalized.admission_policy && normalized.admission_policy.duplicate_window_hours);
  if (Number.isFinite(duplicateWindow) && duplicateWindow < 1) {
    errors.push('admission_policy_duplicate_window_invalid');
  }

  const maxRisk = Number(normalized.risk_policy && normalized.risk_policy.max_risk_per_action);
  if (Number.isFinite(maxRisk) && maxRisk < 15) {
    warnings.push('risk_policy_max_risk_per_action_very_low');
  }
  if (
    Number.isFinite(maxRisk)
    && Array.isArray(normalized.risk_policy && normalized.risk_policy.allowed_risks)
    && normalized.risk_policy.allowed_risks.includes('high')
    && maxRisk < 70
  ) {
    warnings.push('risk_policy_high_allowed_but_max_risk_low');
  }

  const promo = normalized.promotion_policy && typeof normalized.promotion_policy === 'object'
    ? normalized.promotion_policy
    : {};
  if (Number(promo.min_shipped || 0) > Number(promo.min_attempted || 0)) {
    errors.push('promotion_policy_min_shipped_gt_min_attempted');
  }
}

function collectSchemaWarnings(src, warnings) {
  for (const key of Object.keys(src || {})) {
    if (!ALLOWED_TOP_KEYS.has(key)) warnings.push(`unknown_top_level_key:${key}`);
  }
}

function normalizeStrategy(raw, filePath) {
  const fileName = path.basename(filePath, path.extname(filePath));
  const src = raw && typeof raw === 'object' ? raw : {};
  const warnings = [];
  const errors = [];
  collectSchemaWarnings(src, warnings);
  const id = asString(src.id) || fileName;
  const name = asString(src.name) || id;
  const status = normalizeStatus(src.status);
  const objective = normalizeObjective(src.objective);
  const generation_policy = normalizeGenerationPolicy(src.generation_policy);
  const campaigns = strategyCampaigns({ campaigns: src.campaigns }, false);
  const tags = asStringArray(src.tags).map(x => x.toLowerCase());
  const risk_policy = normalizeRiskPolicy(src.risk_policy, src.allowed_risks, warnings);
  const admission_policy = normalizeAdmissionPolicy(src.admission_policy);
  const ranking_weights = normalizeRankingWeights(src.ranking_weights, errors);
  const budget_policy = normalizeBudgetPolicy(src.budget_policy);
  const exploration_policy = normalizeExplorationPolicy(src.exploration_policy);
  const stop_policy = normalizeStopPolicy(src.stop_policy);
  const promotion_policy = normalizePromotionPolicy(src.promotion_policy);
  const execution_policy = normalizeExecutionPolicy(src.execution_policy);
  const threshold_overrides = normalizeThresholdOverrides(src.threshold_overrides);
  const value_currency_policy = normalizeValueCurrencyPolicy(src.value_currency_policy);
  if (!objective.primary) warnings.push('objective_primary_missing');
  if (!risk_policy.allowed_risks.length) errors.push('risk_policy_allowed_risks_empty');
  const normalized = {
    id,
    name,
    status,
    file: filePath,
    version: asString(src.version) || '1.0',
    objective,
    campaigns,
    generation_policy,
    tags,
    risk_policy,
    admission_policy,
    ranking_weights,
    budget_policy,
    exploration_policy,
    stop_policy,
    promotion_policy,
    execution_policy,
    threshold_overrides,
    value_currency_policy
  };
  pushValidationChecks(normalized, warnings, errors);
  return {
    ...normalized,
    validation: {
      strict_ok: errors.length === 0,
      errors,
      warnings
    }
  };
}

function listStrategies(options: AnyObj = {}): AnyObj[] {
  const strategyDir = path.resolve(String(options.dir || process.env.AUTONOMY_STRATEGY_DIR || DEFAULT_STRATEGY_DIR));
  if (!fs.existsSync(strategyDir)) return [];
  const files = fs.readdirSync(strategyDir)
    .filter(f => f.endsWith('.json'))
    .sort();
  const out = [];
  for (const f of files) {
    const fp = path.join(strategyDir, f);
    const raw = readJsonSafe(fp, null);
    if (!raw || typeof raw !== 'object') continue;
    out.push(normalizeStrategy(raw, fp));
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

function loadActiveStrategy(options: AnyObj = {}): AnyObj | null {
  const allowMissing = options.allowMissing === true;
  const strict = options.strict === true || String(process.env.AUTONOMY_STRATEGY_STRICT || '') === '1';
  const requestedId = asString(options.id || process.env.AUTONOMY_STRATEGY_ID);
  const strategies = listStrategies(options);
  if (!strategies.length) {
    if (allowMissing) return null;
    throw new Error('no strategy profiles found');
  }

  if (requestedId) {
    const hit = strategies.find(s => s.id === requestedId);
    if (!hit) {
      if (allowMissing) return null;
      throw new Error(`strategy not found: ${requestedId}`);
    }
    if (strict && hit.validation && hit.validation.strict_ok === false) {
      throw new Error(`strategy_invalid:${requestedId}:${(hit.validation.errors || []).join(',')}`);
    }
    return applyOutcomeFitnessOverlay(hit);
  }

  const active = strategies.filter(s => s.status === 'active');
  if (active.length) {
    const pick = active[0];
    if (strict && pick.validation && pick.validation.strict_ok === false) {
      throw new Error(`strategy_invalid:${pick.id}:${(pick.validation.errors || []).join(',')}`);
    }
    return applyOutcomeFitnessOverlay(pick);
  }
  if (allowMissing) return null;
  throw new Error('no active strategy profile');
}

function effectiveAllowedRisks(defaultSet, strategy) {
  const defaults = defaultSet instanceof Set
    ? Array.from(defaultSet).map(x => asString(x).toLowerCase()).filter(Boolean)
    : [];
  const fromStrategy = strategy
    && strategy.risk_policy
    && Array.isArray(strategy.risk_policy.allowed_risks)
      ? strategy.risk_policy.allowed_risks.map(x => asString(x).toLowerCase()).filter(Boolean)
      : [];
  const chosen = fromStrategy.length ? fromStrategy : defaults;
  return new Set(chosen);
}

function applyThresholdOverrides(baseThresholds, strategy) {
  const base = baseThresholds && typeof baseThresholds === 'object' ? { ...baseThresholds } : {};
  const overrides = strategy && strategy.threshold_overrides && typeof strategy.threshold_overrides === 'object'
    ? strategy.threshold_overrides
    : {};
  for (const [key, value] of Object.entries(overrides)) {
    if (!THRESHOLD_KEYS.has(key)) continue;
    const n = Number(value);
    if (!Number.isFinite(n)) continue;
    base[key] = n;
  }
  return base;
}

function strategyExecutionMode(strategy, fallback = 'execute') {
  const modeRaw = strategy && strategy.execution_policy
    ? asString(strategy.execution_policy.mode).toLowerCase()
    : '';
  const fallbackRaw = asString(fallback).toLowerCase();
  const fallbackMode = fallbackRaw === 'score_only'
    ? 'score_only'
    : (fallbackRaw === 'canary_execute' ? 'canary_execute' : 'execute');
  if (modeRaw === 'score_only') return 'score_only';
  if (modeRaw === 'canary_execute') return 'canary_execute';
  if (modeRaw === 'execute') return 'execute';
  return fallbackMode;
}

function strategyGenerationMode(strategy, fallback = 'hyper-creative') {
  const modeRaw = strategy && strategy.generation_policy
    ? asString(strategy.generation_policy.mode).toLowerCase()
    : '';
  if (STRATEGY_GENERATION_MODES.has(modeRaw)) return modeRaw;
  const fallbackRaw = asString(fallback).toLowerCase();
  return STRATEGY_GENERATION_MODES.has(fallbackRaw) ? fallbackRaw : 'hyper-creative';
}

function strategyCanaryDailyExecLimit(strategy, fallback = null) {
  const raw = strategy
    && strategy.execution_policy
    ? strategy.execution_policy.canary_daily_exec_limit
    : null;
  if (raw != null && String(raw).trim() !== '') {
    const v = Number(raw);
    if (Number.isFinite(v)) return Math.max(1, Math.min(20, Math.round(v)));
  }
  const fv = Number(fallback);
  if (Number.isFinite(fv) && fv > 0) return Math.max(1, Math.min(20, Math.round(fv)));
  return null;
}

function strategyBudgetCaps(strategy: AnyObj, defaults: AnyObj = {}): AnyObj {
  const defaultRuns = Number(defaults.daily_runs_cap);
  const defaultTokens = Number(defaults.daily_token_cap);
  const defaultPerAction = Number(defaults.max_tokens_per_action);
  const defaultTokenCostPer1k = Number(defaults.token_cost_per_1k);
  const defaultDailyUsdCap = Number(defaults.daily_usd_cap);
  const defaultPerActionAvgUsdCap = Number(defaults.per_action_avg_usd_cap);
  const defaultMonthlyUsdAllocation = Number(defaults.monthly_usd_allocation);
  const defaultMonthlyCreditsFloorPct = Number(defaults.monthly_credits_floor_pct);
  const defaultMinProjectedTokensForBurnCheck = Number(defaults.min_projected_tokens_for_burn_check);
  const runs = strategy && strategy.budget_policy && Number.isFinite(Number(strategy.budget_policy.daily_runs_cap))
    ? Number(strategy.budget_policy.daily_runs_cap)
    : (Number.isFinite(defaultRuns) ? defaultRuns : null);
  const tokens = strategy && strategy.budget_policy && Number.isFinite(Number(strategy.budget_policy.daily_token_cap))
    ? Number(strategy.budget_policy.daily_token_cap)
    : (Number.isFinite(defaultTokens) ? defaultTokens : null);
  const perAction = strategy
    && strategy.budget_policy
    && strategy.budget_policy.max_tokens_per_action != null
    && String(strategy.budget_policy.max_tokens_per_action).trim() !== ''
    && Number.isFinite(Number(strategy.budget_policy.max_tokens_per_action))
    ? Number(strategy.budget_policy.max_tokens_per_action)
    : (Number.isFinite(defaultPerAction) ? defaultPerAction : null);
  const tokenCostPer1k = strategy
    && strategy.budget_policy
    && Number.isFinite(Number(strategy.budget_policy.token_cost_per_1k))
    && Number(strategy.budget_policy.token_cost_per_1k) > 0
    ? Number(strategy.budget_policy.token_cost_per_1k)
    : (Number.isFinite(defaultTokenCostPer1k) && defaultTokenCostPer1k > 0 ? defaultTokenCostPer1k : null);
  const dailyUsdCap = strategy
    && strategy.budget_policy
    && Number.isFinite(Number(strategy.budget_policy.daily_usd_cap))
    && Number(strategy.budget_policy.daily_usd_cap) > 0
    ? Number(strategy.budget_policy.daily_usd_cap)
    : (Number.isFinite(defaultDailyUsdCap) && defaultDailyUsdCap > 0 ? defaultDailyUsdCap : null);
  const perActionAvgUsdCap = strategy
    && strategy.budget_policy
    && Number.isFinite(Number(strategy.budget_policy.per_action_avg_usd_cap))
    && Number(strategy.budget_policy.per_action_avg_usd_cap) > 0
    ? Number(strategy.budget_policy.per_action_avg_usd_cap)
    : (Number.isFinite(defaultPerActionAvgUsdCap) && defaultPerActionAvgUsdCap > 0 ? defaultPerActionAvgUsdCap : null);
  const monthlyUsdAllocation = strategy
    && strategy.budget_policy
    && Number.isFinite(Number(strategy.budget_policy.monthly_usd_allocation))
    && Number(strategy.budget_policy.monthly_usd_allocation) > 0
    ? Number(strategy.budget_policy.monthly_usd_allocation)
    : (Number.isFinite(defaultMonthlyUsdAllocation) && defaultMonthlyUsdAllocation > 0 ? defaultMonthlyUsdAllocation : null);
  const monthlyCreditsFloorPct = strategy
    && strategy.budget_policy
    && Number.isFinite(Number(strategy.budget_policy.monthly_credits_floor_pct))
    ? Number(clampNumber(strategy.budget_policy.monthly_credits_floor_pct, 0, 0.95, 0.2).toFixed(4))
    : (Number.isFinite(defaultMonthlyCreditsFloorPct)
      ? Number(clampNumber(defaultMonthlyCreditsFloorPct, 0, 0.95, 0.2).toFixed(4))
      : null);
  const minProjectedTokensForBurnCheck = strategy
    && strategy.budget_policy
    && Number.isFinite(Number(strategy.budget_policy.min_projected_tokens_for_burn_check))
    && Number(strategy.budget_policy.min_projected_tokens_for_burn_check) >= 0
    ? Math.round(Number(strategy.budget_policy.min_projected_tokens_for_burn_check))
    : (Number.isFinite(defaultMinProjectedTokensForBurnCheck) && defaultMinProjectedTokensForBurnCheck >= 0
      ? Math.round(defaultMinProjectedTokensForBurnCheck)
      : null);
  return {
    daily_runs_cap: runs,
    daily_token_cap: tokens,
    max_tokens_per_action: perAction,
    token_cost_per_1k: tokenCostPer1k,
    daily_usd_cap: dailyUsdCap,
    per_action_avg_usd_cap: perActionAvgUsdCap,
    monthly_usd_allocation: monthlyUsdAllocation,
    monthly_credits_floor_pct: monthlyCreditsFloorPct,
    min_projected_tokens_for_burn_check: minProjectedTokensForBurnCheck,
    per_capability_caps: strategy
      && strategy.budget_policy
      && strategy.budget_policy.per_capability_caps
      && typeof strategy.budget_policy.per_capability_caps === 'object'
      ? { ...strategy.budget_policy.per_capability_caps }
      : {}
  };
}

function strategyExplorationPolicy(strategy: AnyObj, defaults: AnyObj = {}): AnyObj {
  const base = {
    fraction: Number.isFinite(Number(defaults.fraction)) ? Number(defaults.fraction) : 0.25,
    every_n: Number.isFinite(Number(defaults.every_n)) ? Number(defaults.every_n) : 3,
    min_eligible: Number.isFinite(Number(defaults.min_eligible)) ? Number(defaults.min_eligible) : 3
  };
  if (!strategy || !strategy.exploration_policy) return base;
  return {
    fraction: Number(strategy.exploration_policy.fraction),
    every_n: Number(strategy.exploration_policy.every_n),
    min_eligible: Number(strategy.exploration_policy.min_eligible)
  };
}

function resolveStrategyRankingContext(strategy, context: AnyObj = {}) {
  const base = strategy && strategy.ranking_weights && typeof strategy.ranking_weights === 'object'
    ? strategy.ranking_weights
    : normalizeRankingWeights({}, []);
  const policy = strategy && strategy.value_currency_policy && typeof strategy.value_currency_policy === 'object'
    ? strategy.value_currency_policy
    : null;
  const objectiveId = asString(context.objective_id);
  const requestedCurrency = normalizeValueCurrencyToken(context.value_currency);
  const applied = [] as string[];
  let selectedCurrency = requestedCurrency || null;
  let weights = { ...base };

  if (policy) {
    const objectiveOverrides = policy.objective_overrides && typeof policy.objective_overrides === 'object'
      ? policy.objective_overrides
      : {};
    const currencyOverrides = policy.currency_overrides && typeof policy.currency_overrides === 'object'
      ? policy.currency_overrides
      : {};
    const objectiveHit = objectiveId && objectiveOverrides[objectiveId] && typeof objectiveOverrides[objectiveId] === 'object'
      ? objectiveOverrides[objectiveId]
      : null;
    if (objectiveHit && objectiveHit.ranking_weights && typeof objectiveHit.ranking_weights === 'object') {
      weights = mergeRankingWeights(weights, objectiveHit.ranking_weights);
      applied.push(`objective:${objectiveId}`);
    }
    if (!selectedCurrency && objectiveHit && normalizeValueCurrencyToken(objectiveHit.primary_currency)) {
      selectedCurrency = normalizeValueCurrencyToken(objectiveHit.primary_currency);
    }
    if (!selectedCurrency && normalizeValueCurrencyToken(policy.default_currency)) {
      selectedCurrency = normalizeValueCurrencyToken(policy.default_currency);
    }
    const currencyHit = selectedCurrency
      && currencyOverrides[selectedCurrency]
      && typeof currencyOverrides[selectedCurrency] === 'object'
      ? currencyOverrides[selectedCurrency]
      : null;
    if (currencyHit && currencyHit.ranking_weights && typeof currencyHit.ranking_weights === 'object') {
      weights = mergeRankingWeights(weights, currencyHit.ranking_weights);
      applied.push(`currency:${selectedCurrency}`);
    }
  }
  return {
    objective_id: objectiveId || null,
    value_currency: selectedCurrency || null,
    weights,
    applied_overrides: applied
  };
}

function strategyRankingWeights(strategy, context: AnyObj = {}) {
  return resolveStrategyRankingContext(strategy, context).weights;
}

function strategyCampaigns(strategy: AnyObj, activeOnly: boolean = false): AnyObj[] {
  const rows = Array.isArray(strategy && strategy.campaigns) ? strategy.campaigns : [];
  const out: AnyObj[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const id = asString(row.id).toLowerCase();
    if (!id) continue;
    const status = normalizeStatus((row as AnyObj).status);
    if (activeOnly && status !== 'active') continue;
    const objectiveId = asString((row as AnyObj).objective_id || (row as AnyObj).directive_ref);
    out.push({
      ...(row as AnyObj),
      id,
      status,
      objective_id: objectiveId || null
    });
  }
  return out;
}

function strategyAllowsProposalType(strategy, proposalType) {
  if (!strategy || !strategy.admission_policy) return true;
  const type = asString(proposalType).toLowerCase();
  const allowed = Array.isArray(strategy.admission_policy.allowed_types)
    ? strategy.admission_policy.allowed_types
    : [];
  const blocked = Array.isArray(strategy.admission_policy.blocked_types)
    ? strategy.admission_policy.blocked_types
    : [];
  if (!type) return allowed.length === 0;
  if (blocked.includes(type)) return false;
  if (allowed.length === 0) return true;
  return allowed.includes(type);
}

function strategyPromotionPolicy(strategy, defaults = {}) {
  const base = normalizePromotionPolicy(defaults);
  if (!strategy || !strategy.promotion_policy || typeof strategy.promotion_policy !== 'object') return base;
  return normalizePromotionPolicy({ ...base, ...strategy.promotion_policy });
}

function strategyMaxRiskPerAction(strategy, fallback = null) {
  const raw = strategy && strategy.risk_policy ? strategy.risk_policy.max_risk_per_action : null;
  if (raw != null && String(raw).trim() !== '') {
    const v = Number(raw);
    if (Number.isFinite(v)) return Math.max(0, Math.min(100, Math.round(v)));
  }
  const fv = Number(fallback);
  if (Number.isFinite(fv)) return Math.max(0, Math.min(100, Math.round(fv)));
  return null;
}

function strategyDuplicateWindowHours(strategy, fallback = 24) {
  const v = strategy
    && strategy.admission_policy
    ? Number(strategy.admission_policy.duplicate_window_hours)
    : NaN;
  if (Number.isFinite(v)) return Math.max(1, Math.min(168, Math.round(v)));
  const fv = Number(fallback);
  if (Number.isFinite(fv)) return Math.max(1, Math.min(168, Math.round(fv)));
  return 24;
}

module.exports = {
  DEFAULT_STRATEGY_DIR,
  THRESHOLD_KEYS,
  listStrategies,
  loadActiveStrategy,
  effectiveAllowedRisks,
  applyThresholdOverrides,
  strategyExecutionMode,
  strategyGenerationMode,
  strategyCanaryDailyExecLimit,
  strategyBudgetCaps,
  strategyExplorationPolicy,
  strategyRankingWeights,
  resolveStrategyRankingContext,
  strategyCampaigns,
  strategyAllowsProposalType,
  strategyPromotionPolicy,
  strategyMaxRiskPerAction,
  strategyDuplicateWindowHours
};
