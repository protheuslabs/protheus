#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_EXCEPTION_POLICY_PATH = process.env.AUTONOMY_EXCEPTION_POLICY_PATH
  ? path.resolve(process.env.AUTONOMY_EXCEPTION_POLICY_PATH)
  : path.join(REPO_ROOT, 'config', 'autonomy_exception_recovery_policy.json');

type AnyObj = Record<string, any>;

function clampNumber(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return min;
  if (x < min) return min;
  if (x > max) return max;
  return x;
}

function nowIso() {
  return new Date().toISOString();
}

function dateArgOrToday(v) {
  if (v && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  return new Date().toISOString().slice(0, 10);
}

function shiftDate(dateStr, deltaDays) {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  if (isNaN(d.getTime())) return dateStr;
  d.setUTCDate(d.getUTCDate() + Number(deltaDays || 0));
  return d.toISOString().slice(0, 10);
}

function dateWindow(endDateStr, days) {
  const out = [];
  const n = Math.max(1, Number(days || 1));
  for (let i = n - 1; i >= 0; i -= 1) out.push(shiftDate(endDateStr, -i));
  return out;
}

function normalizeText(v) {
  return String(v == null ? '' : v).trim();
}

function truthyFlag(v: any, fallback = false): boolean {
  if (v == null) return fallback;
  if (typeof v === 'boolean') return v;
  const s = normalizeText(v).toLowerCase();
  if (!s) return fallback;
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function saveJson(filePath, obj) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), 'utf8');
}

function appendJsonl(filePath, obj) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(obj)}\n`);
}

function readJsonlFile(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
  const out = [];
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj && typeof obj === 'object') out.push(obj);
    } catch {
      // ignore malformed lines
    }
  }
  return out;
}

function loadRunEvents(runsDir, endDateStr, days) {
  const events = [];
  for (const day of dateWindow(endDateStr, days)) {
    const fp = path.join(runsDir, `${day}.jsonl`);
    const rows = readJsonlFile(fp);
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      const ts = normalizeText(row.ts);
      const dayFromTs = ts && /^\d{4}-\d{2}-\d{2}/.test(ts) ? ts.slice(0, 10) : day;
      events.push({ ...row, __date: dayFromTs });
    }
  }
  events.sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')));
  return events;
}

function extractTokenUsage(evt) {
  if (!evt || typeof evt !== 'object') return 0;
  const tokenUsage = evt.token_usage && typeof evt.token_usage === 'object' ? evt.token_usage : null;
  const direct = tokenUsage ? Number(tokenUsage.effective_tokens) : NaN;
  if (Number.isFinite(direct) && direct >= 0) return direct;
  const routeEst = Number(evt.route_tokens_est);
  if (Number.isFinite(routeEst) && routeEst >= 0) return routeEst;
  const est = Number(evt.est_tokens);
  if (Number.isFinite(est) && est >= 0) return est;
  return 0;
}

function extractOutcomeScore(evt) {
  const outcome = String(evt && evt.outcome || '').toLowerCase();
  if (outcome === 'shipped') return 1;
  if (outcome === 'no_change') return 0.35;
  if (outcome === 'reverted') return 0;
  return 0.2;
}

function extractDirectiveFitScore(evt) {
  const d = evt && evt.directive_fit && typeof evt.directive_fit === 'object' ? evt.directive_fit : null;
  const n = Number(d && d.score);
  return Number.isFinite(n) ? clampNumber(n, 0, 100) : null;
}

function extractCompositeScore(evt) {
  const c = evt && evt.composite && typeof evt.composite === 'object' ? evt.composite : null;
  const n = Number(c && c.score);
  return Number.isFinite(n) ? clampNumber(n, 0, 100) : null;
}

function extractExpectedValueScore(evt) {
  const v = evt && evt.value_signal && typeof evt.value_signal === 'object' ? evt.value_signal : null;
  const c = v && v.components && typeof v.components === 'object' ? v.components : null;
  const expected = Number(c && c.expected_value);
  if (Number.isFinite(expected)) return clampNumber(expected, 0, 100);
  const score = Number(v && v.score);
  return Number.isFinite(score) ? clampNumber(score, 0, 100) : null;
}

function avg(arr) {
  const vals = (arr || [])
    .map((v) => (v == null ? NaN : Number(v)))
    .filter(Number.isFinite);
  if (!vals.length) return null;
  return vals.reduce((s, x) => s + x, 0) / vals.length;
}

function ema(values, alpha) {
  const vals = (values || []).map(Number).filter(Number.isFinite);
  if (!vals.length) return null;
  const a = clampNumber(Number(alpha || 0.35), 0.05, 0.95);
  let cur = vals[0];
  for (let i = 1; i < vals.length; i += 1) cur = (a * vals[i]) + ((1 - a) * cur);
  return cur;
}

function executedRuns(events) {
  return (events || []).filter((e) => e && e.type === 'autonomy_run' && e.result === 'executed');
}

function hasAlignmentObjective(evt: AnyObj = {}): boolean {
  const direct = normalizeText(evt.objective_id || '');
  if (direct) return true;
  const meta = evt.meta && typeof evt.meta === 'object' ? evt.meta : null;
  const viaMeta = normalizeText(meta && meta.objective_id || '');
  return Boolean(viaMeta);
}

function hasAlignmentSignals(evt: AnyObj = {}): boolean {
  return extractExpectedValueScore(evt) != null
    || extractDirectiveFitScore(evt) != null
    || extractCompositeScore(evt) != null;
}

function isLegacyExecutedRow(evt: AnyObj = {}): boolean {
  if (!hasAlignmentObjective(evt)) return true;
  if (!hasAlignmentSignals(evt)) return true;
  return false;
}

function dailyTokenTotals(executedEvents) {
  const map = {};
  for (const evt of executedEvents) {
    const day = normalizeText(evt.__date || (evt.ts || '').slice(0, 10));
    if (!day) continue;
    map[day] = Number(map[day] || 0) + extractTokenUsage(evt);
  }
  return map;
}

function monthPrefix(dateStr) {
  const s = String(dateStr || '');
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s.slice(0, 7) : '';
}

function evaluateCostGovernor(opts: AnyObj = {}): AnyObj {
  const runsDir = opts.runsDir;
  const dateStr = dateArgOrToday(opts.dateStr);
  const estActionTokens = Math.max(0, Number(opts.estActionTokens || 0));
  const attemptsToday = Math.max(0, Number(opts.attemptsToday || 0));

  const tokenCostPer1k = Math.max(0, Number(opts.tokenCostPer1k || 0));
  const dailyUsdCap = Math.max(0, Number(opts.dailyUsdCap || 0));
  const perActionAvgUsdCap = Math.max(0, Number(opts.perActionAvgUsdCap || 0));
  const burnRateMultiplier = Math.max(1, Number(opts.burnRateMultiplier || 1.5));
  const minProjectedTokensForBurnCheck = Math.max(0, Number(opts.minProjectedTokensForBurnCheck || 600));
  const monthlyUsdAllocation = Math.max(0, Number(opts.monthlyUsdAllocation || 0));
  const monthlyCreditsFloorPct = clampNumber(Number(opts.monthlyCreditsFloorPct || 0.2), 0, 0.95);
  const minDaysForBurnBaseline = Math.max(1, Number(opts.minDaysForBurnBaseline || 3));

  const events = loadRunEvents(runsDir, dateStr, 45);
  const executed = executedRuns(events);
  const byDay = dailyTokenTotals(executed);
  const todayTokens = Number(byDay[dateStr] || 0);
  const projectedTodayTokens = todayTokens + estActionTokens;

  const prior7 = dateWindow(shiftDate(dateStr, -1), 7);
  const prior7Tokens = prior7.map((d) => Number(byDay[d] || 0));
  const prior7NonZeroDays = prior7Tokens.filter((n) => n > 0).length;
  const avgPrior7Tokens = avg(prior7Tokens) || 0;
  const burnRateRatio = avgPrior7Tokens > 0 ? projectedTodayTokens / avgPrior7Tokens : null;
  const burnRateExceeded = prior7NonZeroDays >= minDaysForBurnBaseline
    && avgPrior7Tokens > 0
    && projectedTodayTokens >= minProjectedTokensForBurnCheck
    && projectedTodayTokens > (avgPrior7Tokens * burnRateMultiplier);

  const usdFromTokens = (tokens) => tokenCostPer1k > 0 ? (Number(tokens || 0) / 1000) * tokenCostPer1k : null;
  const todayUsd = usdFromTokens(todayTokens);
  const projectedTodayUsd = usdFromTokens(projectedTodayTokens);
  const projectedActionAvgUsd = projectedTodayUsd == null
    ? null
    : projectedTodayUsd / Math.max(1, attemptsToday + 1);

  const month = monthPrefix(dateStr);
  let monthTokensSpent = 0;
  if (month) {
    for (const [day, tok] of Object.entries(byDay)) {
      if (String(day).startsWith(month)) monthTokensSpent += Number(tok || 0);
    }
  }
  const monthUsdSpent = usdFromTokens(monthTokensSpent);
  const monthRemainingPct = monthlyUsdAllocation > 0 && monthUsdSpent != null
    ? clampNumber(1 - (monthUsdSpent / monthlyUsdAllocation), 0, 1)
    : null;

  const hardStopReasons = [];
  if (burnRateExceeded) hardStopReasons.push('burn_rate_exceeded');
  if (projectedTodayUsd != null && dailyUsdCap > 0 && projectedTodayUsd > dailyUsdCap) {
    hardStopReasons.push('daily_usd_cap_exceeded');
  }
  if (projectedActionAvgUsd != null && perActionAvgUsdCap > 0 && projectedActionAvgUsd > perActionAvgUsdCap) {
    hardStopReasons.push('per_action_avg_usd_exceeded');
  }
  if (monthRemainingPct != null && monthRemainingPct < monthlyCreditsFloorPct) {
    hardStopReasons.push('monthly_credits_floor_breached');
  }

  return {
    enabled: true,
    hard_stop: hardStopReasons.length > 0,
    hard_stop_reasons: hardStopReasons,
    burn_rate_exceeded: burnRateExceeded,
    burn_rate_ratio: burnRateRatio == null ? null : Number(burnRateRatio.toFixed(3)),
    burn_rate_multiplier: burnRateMultiplier,
    min_projected_tokens_for_burn_check: minProjectedTokensForBurnCheck,
    prior7_nonzero_days: prior7NonZeroDays,
    avg_prior7_tokens: Number(avgPrior7Tokens.toFixed(2)),
    today_tokens: Number(todayTokens.toFixed(2)),
    projected_today_tokens: Number(projectedTodayTokens.toFixed(2)),
    token_cost_per_1k: tokenCostPer1k,
    daily_usd_cap: dailyUsdCap || null,
    per_action_avg_usd_cap: perActionAvgUsdCap || null,
    monthly_usd_allocation: monthlyUsdAllocation || null,
    monthly_credits_floor_pct: monthlyCreditsFloorPct,
    today_usd: todayUsd == null ? null : Number(todayUsd.toFixed(4)),
    projected_today_usd: projectedTodayUsd == null ? null : Number(projectedTodayUsd.toFixed(4)),
    projected_action_avg_usd: projectedActionAvgUsd == null ? null : Number(projectedActionAvgUsd.toFixed(4)),
    month_usd_spent: monthUsdSpent == null ? null : Number(monthUsdSpent.toFixed(4)),
    month_remaining_pct: monthRemainingPct == null ? null : Number(monthRemainingPct.toFixed(3))
  };
}

function evaluateDrift(opts: AnyObj = {}): AnyObj {
  const runsDir = opts.runsDir;
  const dateStr = dateArgOrToday(opts.dateStr);
  const recentDays = Math.max(3, Number(opts.recentDays || 7));
  const baselineDays = Math.max(7, Number(opts.baselineDays || 21));
  const emaThreshold = clampNumber(Number(opts.emaThreshold || 0.55), 0.05, 0.99);
  const tokenRatioThreshold = Math.max(1.1, Number(opts.tokenRatioThreshold || 3));
  const errorRateThreshold = clampNumber(Number(opts.errorRateThreshold || 0.35), 0.05, 0.95);
  const minSamples = Math.max(2, Number(opts.minSamples || 6));
  const hardStopOnHigh = String(opts.hardStopOnHigh || '1') !== '0';

  const windowDays = recentDays + baselineDays;
  const events = loadRunEvents(runsDir, dateStr, windowDays);
  const executed = executedRuns(events);
  const recentStart = shiftDate(dateStr, -(recentDays - 1));
  const baselineStart = shiftDate(dateStr, -(windowDays - 1));
  const baselineEnd = shiftDate(recentStart, -1);
  const inRange = (day, a, b) => String(day || '') >= String(a || '') && String(day || '') <= String(b || '');
  const recent = executed.filter((e) => inRange(e.__date, recentStart, dateStr));
  const baseline = executed.filter((e) => inRange(e.__date, baselineStart, baselineEnd));

  const recentOutcomeScores = recent.map(extractOutcomeScore);
  const baselineOutcomeScores = baseline.map(extractOutcomeScore);
  const recentEma = ema(recentOutcomeScores, 0.35);
  const baselineEma = ema(baselineOutcomeScores, 0.35);
  const recentShipped = recent.filter((e) => String(e.outcome || '') === 'shipped').length;
  const baselineShipped = baseline.filter((e) => String(e.outcome || '') === 'shipped').length;
  const recentReverted = recent.filter((e) => String(e.outcome || '') === 'reverted').length;
  const baselineReverted = baseline.filter((e) => String(e.outcome || '') === 'reverted').length;
  const recentTokens = recent.reduce((s, e) => s + extractTokenUsage(e), 0);
  const baselineTokens = baseline.reduce((s, e) => s + extractTokenUsage(e), 0);
  const tokenPerShippedRecent = recentShipped > 0 ? recentTokens / recentShipped : null;
  const tokenPerShippedBaseline = baselineShipped > 0 ? baselineTokens / baselineShipped : null;
  const tokenEfficiencyRatio = tokenPerShippedRecent != null && tokenPerShippedBaseline != null && tokenPerShippedBaseline > 0
    ? tokenPerShippedRecent / tokenPerShippedBaseline
    : null;
  const errorRateRecent = recent.length > 0 ? recentReverted / recent.length : null;
  const errorRateBaseline = baseline.length > 0 ? baselineReverted / baseline.length : null;
  const alignRecent = avg(recent.map((e) => {
    const d = extractDirectiveFitScore(e);
    const c = extractCompositeScore(e);
    if (d == null && c == null) return null;
    if (d != null && c != null) return (d + c) / 2;
    return d == null ? c : d;
  }));

  const triggers = [];
  if (recent.length >= minSamples && recentEma != null && recentEma < emaThreshold) {
    triggers.push('decision_quality_ema_low');
  }
  if (recent.length >= minSamples && tokenEfficiencyRatio != null && tokenEfficiencyRatio > tokenRatioThreshold) {
    triggers.push('token_efficiency_regressed');
  }
  if (recent.length >= minSamples && errorRateRecent != null) {
    const baselineBound = errorRateBaseline != null ? Math.max(errorRateThreshold, errorRateBaseline * 1.5) : errorRateThreshold;
    if (errorRateRecent > baselineBound) triggers.push('error_rate_spike');
  }
  if (recent.length >= minSamples && alignRecent != null && alignRecent < 45) {
    triggers.push('strategic_alignment_drift');
  }

  const severity = triggers.length >= 2 ? 'high' : (triggers.length === 1 ? 'warn' : 'none');
  return {
    enabled: true,
    severity,
    triggers,
    hard_stop: hardStopOnHigh && severity === 'high',
    metrics: {
      recent_samples: recent.length,
      baseline_samples: baseline.length,
      decision_quality_ema_recent: recentEma == null ? null : Number(recentEma.toFixed(3)),
      decision_quality_ema_baseline: baselineEma == null ? null : Number(baselineEma.toFixed(3)),
      token_per_shipped_recent: tokenPerShippedRecent == null ? null : Number(tokenPerShippedRecent.toFixed(2)),
      token_per_shipped_baseline: tokenPerShippedBaseline == null ? null : Number(tokenPerShippedBaseline.toFixed(2)),
      token_efficiency_ratio: tokenEfficiencyRatio == null ? null : Number(tokenEfficiencyRatio.toFixed(3)),
      error_rate_recent: errorRateRecent == null ? null : Number(errorRateRecent.toFixed(3)),
      error_rate_baseline: errorRateBaseline == null ? null : Number(errorRateBaseline.toFixed(3)),
      strategic_alignment_recent: alignRecent == null ? null : Number(alignRecent.toFixed(2))
    }
  };
}

function weeklyAlignmentScore(executedEvents, endDateStr, opts: AnyObj = {}) {
  const includeLegacyExecuted = truthyFlag(
    opts.includeLegacyExecuted == null
      ? (process.env.AUTONOMY_ALIGNMENT_INCLUDE_LEGACY_EXECUTED || '0')
      : opts.includeLegacyExecuted
  );
  const start = shiftDate(endDateStr, -6);
  const sourceRows = executedEvents.filter((e) => String(e.__date || '') >= start && String(e.__date || '') <= endDateStr);
  const rows = includeLegacyExecuted ? sourceRows : sourceRows.filter((e) => !isLegacyExecutedRow(e));
  const filteredLegacyCount = Math.max(0, sourceRows.length - rows.length);
  if (!rows.length) {
    return {
      start,
      end: endDateStr,
      sample: 0,
      sample_raw: sourceRows.length,
      filtered_legacy: filteredLegacyCount,
      include_legacy_executed: includeLegacyExecuted,
      score: null,
      components: {
        revenue_potential: null,
        compounding_value: null,
        risk_reduction: null,
        learning_velocity: null
      }
    };
  }

  const revenuePotential = avg(rows.map(extractExpectedValueScore));
  const compoundingValue = avg(rows.map((e) => {
    const d = extractDirectiveFitScore(e);
    const c = extractCompositeScore(e);
    if (d == null && c == null) return null;
    if (d != null && c != null) return (d + c) / 2;
    return d == null ? c : d;
  }));
  const shipped = rows.filter((e) => String(e.outcome || '') === 'shipped').length;
  const noChange = rows.filter((e) => String(e.outcome || '') === 'no_change').length;
  const reverted = rows.filter((e) => String(e.outcome || '') === 'reverted').length;
  const revertedRate = rows.length > 0 ? reverted / rows.length : 0;
  const noChangeRate = rows.length > 0 ? noChange / rows.length : 0;
  const riskReduction = clampNumber(100 - (revertedRate * 100) - (noChangeRate * 40), 0, 100);
  const learningVelocity = clampNumber((rows.length * 12) + (shipped * 8), 0, 100);

  const rp = revenuePotential == null ? 0 : revenuePotential;
  const cv = compoundingValue == null ? 0 : compoundingValue;
  const score = (rp * 0.4) + (cv * 0.3) + (riskReduction * 0.2) + (learningVelocity * 0.1);

  return {
    start,
    end: endDateStr,
    sample: rows.length,
    sample_raw: sourceRows.length,
    filtered_legacy: filteredLegacyCount,
    include_legacy_executed: includeLegacyExecuted,
    score: Number(score.toFixed(2)),
    components: {
      revenue_potential: revenuePotential == null ? null : Number(revenuePotential.toFixed(2)),
      compounding_value: compoundingValue == null ? null : Number(compoundingValue.toFixed(2)),
      risk_reduction: Number(riskReduction.toFixed(2)),
      learning_velocity: Number(learningVelocity.toFixed(2))
    }
  };
}

function evaluateStrategicAlignment(opts: AnyObj = {}): AnyObj {
  const runsDir = opts.runsDir;
  const dateStr = dateArgOrToday(opts.dateStr);
  const threshold = clampNumber(Number(opts.threshold || 60), 10, 95);
  const minWeekSamples = Math.max(1, Number(opts.minWeekSamples || 3));
  const includeLegacyExecuted = truthyFlag(
    opts.includeLegacyExecuted == null
      ? (process.env.AUTONOMY_ALIGNMENT_INCLUDE_LEGACY_EXECUTED || '0')
      : opts.includeLegacyExecuted
  );
  const events = loadRunEvents(runsDir, dateStr, 21);
  const executed = executedRuns(events);
  const currentWeek = weeklyAlignmentScore(executed, dateStr, { includeLegacyExecuted });
  const prevWeekEnd = shiftDate(dateStr, -7);
  const previousWeek = weeklyAlignmentScore(executed, prevWeekEnd, { includeLegacyExecuted });
  const currentLow = currentWeek.score != null && currentWeek.score < threshold && currentWeek.sample >= minWeekSamples;
  const previousLow = previousWeek.score != null && previousWeek.score < threshold && previousWeek.sample >= minWeekSamples;
  const lowStreak = currentLow && previousLow;
  return {
    enabled: true,
    include_legacy_executed: includeLegacyExecuted,
    threshold,
    min_week_samples: minWeekSamples,
    current_week: currentWeek,
    previous_week: previousWeek,
    low_streak: lowStreak,
    escalate: lowStreak
  };
}

function normalizeErrorMessage(msg) {
  return normalizeText(msg)
    .toLowerCase()
    .replace(/\b[0-9a-f]{8,}\b/g, '#hex#')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .slice(0, 220);
}

function classifyAndRecordException(opts: AnyObj = {}): AnyObj {
  const memoryPath = opts.memoryPath;
  const auditPath = opts.auditPath || null;
  const dateStr = dateArgOrToday(opts.dateStr);
  const stage = normalizeText(opts.stage || 'unknown').toLowerCase();
  const errorCode = normalizeText(opts.errorCode || 'unknown');
  const errorMessageNorm = normalizeErrorMessage(opts.errorMessage || '');
  const context = opts.context && typeof opts.context === 'object' ? opts.context : {};
  if (!memoryPath) {
    return {
      tracked: false,
      error: 'memory_path_missing',
      novel: false
    };
  }

  const base = readJsonSafe(memoryPath, { version: 1, signatures: {} });
  const signatures = base.signatures && typeof base.signatures === 'object' ? { ...base.signatures } : {};
  const sigInput = `${stage}|${errorCode}|${errorMessageNorm || 'none'}`;
  const signature = crypto.createHash('sha1').update(sigInput).digest('hex');
  const existing = signatures[signature];
  const novel = !existing;
  const nextCount = Number(existing && existing.count || 0) + 1;
  const now = nowIso();

  signatures[signature] = {
    signature,
    stage,
    error_code: errorCode,
    normalized_message: errorMessageNorm,
    first_seen: existing && existing.first_seen ? existing.first_seen : now,
    last_seen: now,
    count: nextCount
  };
  saveJson(memoryPath, {
    version: 1,
    updated_at: now,
    signatures
  });

  const evt = {
    ts: now,
    type: 'tier1_exception_novelty',
    date: dateStr,
    signature,
    novel,
    stage,
    error_code: errorCode,
    count: nextCount,
    normalized_message: errorMessageNorm,
    context
  };
  if (auditPath) appendJsonl(auditPath, evt);

  return {
    tracked: true,
    novel,
    signature,
    count: nextCount,
    stage,
    error_code: errorCode,
    normalized_message: errorMessageNorm
  };
}

function summarizeExceptionMemory(memoryPath: string, days = 7): AnyObj {
  const raw = readJsonSafe(memoryPath, { signatures: {} });
  const sigs = raw && raw.signatures && typeof raw.signatures === 'object' ? raw.signatures : {};
  const all = Object.values(sigs as AnyObj) as AnyObj[];
  const cutoffMs = Date.now() - (Math.max(1, Number(days || 7)) * 24 * 60 * 60 * 1000);
  let novelRecent = 0;
  for (const ent of all) {
    const first = Date.parse(String(ent && ent.first_seen || ''));
    if (Number.isFinite(first) && first >= cutoffMs) novelRecent += 1;
  }
  return {
    total_signatures: all.length,
    novel_last_n_days: novelRecent,
    memory_updated_at: raw && raw.updated_at ? String(raw.updated_at) : null
  };
}

function normalizeRecoveryAction(v: any) {
  const s = String(v || '').trim().toLowerCase();
  if (s === 'escalate' || s === 'recover' || s === 'cooldown') return s;
  return 'recover';
}

function exceptionRecoveryDecision(opts: AnyObj = {}): AnyObj {
  const tracked = opts.tracked && typeof opts.tracked === 'object' ? opts.tracked : {};
  const policyPath = opts.policyPath ? path.resolve(String(opts.policyPath)) : DEFAULT_EXCEPTION_POLICY_PATH;
  const fallbackPolicy = {
    novel: { action: 'escalate', cooldown_hours: 12, playbook: 'novel_exception_escalation' },
    known_default: { action: 'recover', cooldown_hours: 2, playbook: 'retry_with_backoff' },
    code_overrides: {}
  };
  const policy = readJsonSafe(policyPath, fallbackPolicy);
  const novelCfg = policy && policy.novel && typeof policy.novel === 'object' ? policy.novel : fallbackPolicy.novel;
  const knownDefault = policy && policy.known_default && typeof policy.known_default === 'object'
    ? policy.known_default
    : fallbackPolicy.known_default;
  const codeOverrides = policy && policy.code_overrides && typeof policy.code_overrides === 'object'
    ? policy.code_overrides
    : {};

  const errorCode = String(tracked.error_code || 'unknown').trim();
  const novel = tracked.novel === true;
  let selected = novel ? novelCfg : (codeOverrides[errorCode] || knownDefault);
  if (!selected || typeof selected !== 'object') selected = knownDefault;

  const action = normalizeRecoveryAction(selected.action);
  const cooldownHours = clampNumber(Number(selected.cooldown_hours || 0), 0, 168);
  const playbook = normalizeText(selected.playbook || (novel ? 'novel_exception_escalation' : 'retry_with_backoff'));
  const shouldEscalate = action === 'escalate' || (novel && action !== 'cooldown');

  return {
    action,
    cooldown_hours: cooldownHours,
    playbook,
    reason: novel ? 'novel_exception' : (codeOverrides[errorCode] ? 'known_code_override' : 'known_default'),
    should_escalate: shouldEscalate,
    policy_path: policyPath,
    novel,
    error_code: errorCode
  };
}

function evaluateTier1Governance(opts: AnyObj = {}): AnyObj {
  const runsDir = opts.runsDir;
  const dateStr = dateArgOrToday(opts.dateStr);
  const attemptsToday = Math.max(0, Number(opts.attemptsToday || 0));
  const estActionTokens = Math.max(0, Number(opts.estActionTokens || 0));
  const drift = evaluateDrift({
    runsDir,
    dateStr,
    recentDays: opts.driftRecentDays,
    baselineDays: opts.driftBaselineDays,
    emaThreshold: opts.driftEmaThreshold,
    tokenRatioThreshold: opts.driftTokenRatioThreshold,
    errorRateThreshold: opts.driftErrorRateThreshold,
    minSamples: opts.driftMinSamples,
    hardStopOnHigh: opts.driftHardStopOnHigh
  });
  const cost = evaluateCostGovernor({
    runsDir,
    dateStr,
    estActionTokens,
    attemptsToday,
    tokenCostPer1k: opts.tokenCostPer1k,
    dailyUsdCap: opts.dailyUsdCap,
    perActionAvgUsdCap: opts.perActionAvgUsdCap,
    burnRateMultiplier: opts.burnRateMultiplier,
    minProjectedTokensForBurnCheck: opts.minProjectedTokensForBurnCheck,
    monthlyUsdAllocation: opts.monthlyUsdAllocation,
    monthlyCreditsFloorPct: opts.monthlyCreditsFloorPct,
    minDaysForBurnBaseline: opts.minDaysForBurnBaseline
  });
  const alignment = evaluateStrategicAlignment({
    runsDir,
    dateStr,
    threshold: opts.alignmentThreshold,
    minWeekSamples: opts.alignmentMinWeekSamples
  });

  const blockers = [];
  if (cost.hard_stop) blockers.push({ gate: 'cost_governor', reasons: cost.hard_stop_reasons.slice(0, 6) });
  if (drift.hard_stop) blockers.push({ gate: 'drift_detection', reasons: drift.triggers.slice(0, 6) });
  if (alignment.escalate) blockers.push({ gate: 'alignment_oracle', reasons: ['low_weekly_alignment_two_weeks'] });

  return {
    enabled: true,
    date: dateStr,
    blockers,
    hard_stop: blockers.length > 0,
    cost,
    drift,
    alignment
  };
}

module.exports = {
  evaluateCostGovernor,
  evaluateDrift,
  evaluateStrategicAlignment,
  evaluateTier1Governance,
  classifyAndRecordException,
  summarizeExceptionMemory,
  exceptionRecoveryDecision
};
