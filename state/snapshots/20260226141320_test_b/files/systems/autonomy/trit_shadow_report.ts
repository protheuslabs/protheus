#!/usr/bin/env node
'use strict';
export {};

/**
 * trit_shadow_report.js
 *
 * Summarize Trit shadow divergence from strategy and drift governors.
 *
 * Usage:
 *   node systems/autonomy/trit_shadow_report.js run [YYYY-MM-DD] [--days=N] [--max-divergence-rate=0.35]
 *   node systems/autonomy/trit_shadow_report.js status [YYYY-MM-DD] [--days=N] [--max-divergence-rate=0.35]
 *   node systems/autonomy/trit_shadow_report.js --help
 */

const fs = require('fs');
const path = require('path');
const { loadTritShadowSuccessCriteria } = require('../../lib/trit_shadow_control');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const STRATEGY_MODE_LOG_PATH = process.env.AUTONOMY_TRIT_SHADOW_STRATEGY_LOG_PATH
  ? path.resolve(process.env.AUTONOMY_TRIT_SHADOW_STRATEGY_LOG_PATH)
  : path.join(ROOT, 'state', 'autonomy', 'strategy_mode_changes.jsonl');
const DRIFT_STATE_PATH = process.env.AUTONOMY_TRIT_SHADOW_DRIFT_STATE_PATH
  ? path.resolve(process.env.AUTONOMY_TRIT_SHADOW_DRIFT_STATE_PATH)
  : path.join(ROOT, 'state', 'autonomy', 'drift_target_governor_state.json');
const REPORT_DIR = process.env.AUTONOMY_TRIT_SHADOW_REPORT_DIR
  ? path.resolve(process.env.AUTONOMY_TRIT_SHADOW_REPORT_DIR)
  : path.join(ROOT, 'state', 'autonomy', 'trit_shadow_reports');
const HISTORY_PATH = path.join(REPORT_DIR, 'history.jsonl');
const HEALTH_REPORTS_DIR = process.env.AUTONOMY_TRIT_SHADOW_HEALTH_REPORTS_DIR
  ? path.resolve(process.env.AUTONOMY_TRIT_SHADOW_HEALTH_REPORTS_DIR)
  : path.join(ROOT, 'state', 'autonomy', 'health_reports');

const DEFAULT_MIN_SAMPLES = Math.max(1, Number(process.env.AUTONOMY_TRIT_SHADOW_MIN_SAMPLES || 6));
const DEFAULT_WARN_RATE = clampRate(
  process.env.AUTONOMY_TRIT_SHADOW_WARN_DIVERGENCE_RATE,
  0.2
);
const DEFAULT_CRITICAL_RATE = Math.max(
  DEFAULT_WARN_RATE,
  clampRate(process.env.AUTONOMY_TRIT_SHADOW_CRITICAL_DIVERGENCE_RATE, 0.35)
);
const DEFAULT_MAX_DIVERGENCE_RATE = clampOptionalRate(
  process.env.AUTONOMY_TRIT_SHADOW_MAX_DIVERGENCE_RATE
);

function usage() {
  console.log('Usage:');
  console.log('  node systems/autonomy/trit_shadow_report.js run [YYYY-MM-DD] [--days=N] [--max-divergence-rate=0.35]');
  console.log('  node systems/autonomy/trit_shadow_report.js status [YYYY-MM-DD] [--days=N] [--max-divergence-rate=0.35]');
}

function parseArgs(argv: string[]): AnyObj {
  const out: AnyObj = { _: [] };
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

function nowIso() {
  return new Date().toISOString();
}

function todayStr() {
  return nowIso().slice(0, 10);
}

function isDateStr(v: any) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
}

function clampInt(v: any, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

function clampRate(v: any, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function clampOptionalRate(v: any) {
  if (v == null || String(v).trim() === '') return null;
  return clampRate(v, null);
}

function dateShift(dateStr: string, deltaDays: number) {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + Number(deltaDays || 0));
  return d.toISOString().slice(0, 10);
}

function dateFromTs(ts: any) {
  const ms = Date.parse(String(ts || ''));
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString().slice(0, 10);
}

function ensureDir(dirPath: string) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
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

function readJsonl(filePath: string): AnyObj[] {
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
  const out: AnyObj[] = [];
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

function writeJson(filePath: string, value: AnyObj) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function appendJsonl(filePath: string, row: AnyObj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function inWindow(day: any, startDate: string, endDate: string) {
  if (!isDateStr(day)) return false;
  return String(day) >= startDate && String(day) <= endDate;
}

function makeCounter() {
  return Object.create(null);
}

function addCount(counter: Record<string, number>, key: string) {
  const k = String(key || '').trim();
  if (!k) return;
  counter[k] = Number(counter[k] || 0) + 1;
}

function topCounts(counter: Record<string, number>, limit = 8) {
  return Object.entries(counter)
    .map(([key, count]) => ({ key, count: Number(count || 0) }))
    .sort((a, b) => (b.count - a.count) || a.key.localeCompare(b.key))
    .slice(0, Math.max(1, Number(limit || 8)));
}

function buildEmptySourceSummary(source: string) {
  return {
    source,
    total_decisions: 0,
    divergence_count: 0,
    divergence_rate: 0,
    confidence_avg: null,
    belief_trits: { pain: 0, neutral: 0, ok: 0 },
    top_reasons: [],
    last_ts: null
  };
}

function summarizeStrategyMode(endDate: string, days: number) {
  const startDate = dateShift(endDate, -(days - 1));
  const rows = readJsonl(STRATEGY_MODE_LOG_PATH);
  const summary = buildEmptySourceSummary('strategy_mode_governor');
  const reasons = makeCounter();
  let confidenceSum = 0;
  let confidenceCount = 0;
  let latestMs = 0;

  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const shadow = row.trit_shadow && typeof row.trit_shadow === 'object' ? row.trit_shadow : null;
    if (!shadow) continue;
    const day = isDateStr(row.date) ? String(row.date) : dateFromTs(row.ts);
    if (!inWindow(day, startDate, endDate)) continue;

    const legacyTo = String(shadow.legacy_to_mode || row.to_mode || '').trim();
    const shadowTo = String(shadow.shadow_to_mode || '').trim();
    const divergence = shadow.divergence === true || (!!legacyTo && !!shadowTo && legacyTo !== shadowTo);
    const reason = String(shadow.reason || row.reason || '').trim() || 'unknown';
    const belief = shadow.belief && typeof shadow.belief === 'object' ? shadow.belief : {};
    const trit = Number(belief.trit || 0);
    const confidence = Number(belief.confidence);
    const tsMs = Date.parse(String(row.ts || ''));

    summary.total_decisions += 1;
    if (divergence) summary.divergence_count += 1;
    addCount(reasons, reason);
    if (trit === -1) summary.belief_trits.pain += 1;
    else if (trit === 1) summary.belief_trits.ok += 1;
    else summary.belief_trits.neutral += 1;
    if (Number.isFinite(confidence)) {
      confidenceSum += confidence;
      confidenceCount += 1;
    }
    if (Number.isFinite(tsMs) && tsMs > latestMs) latestMs = tsMs;
  }

  summary.divergence_rate = summary.total_decisions > 0
    ? Number((summary.divergence_count / summary.total_decisions).toFixed(4))
    : 0;
  summary.confidence_avg = confidenceCount > 0 ? Number((confidenceSum / confidenceCount).toFixed(4)) : null;
  summary.top_reasons = topCounts(reasons, 8).map((row) => ({ reason: row.key, count: row.count }));
  summary.last_ts = latestMs > 0 ? new Date(latestMs).toISOString() : null;
  return summary;
}

function summarizeDriftTarget(endDate: string, days: number) {
  const startDate = dateShift(endDate, -(days - 1));
  const rawState = readJson(DRIFT_STATE_PATH, {});
  const history = Array.isArray(rawState && rawState.history) ? rawState.history : [];
  const summary = buildEmptySourceSummary('drift_target_governor');
  const reasons = makeCounter();
  let confidenceSum = 0;
  let confidenceCount = 0;
  let latestMs = 0;

  for (const row of history) {
    if (!row || typeof row !== 'object') continue;
    const shadow = row.trit_shadow && typeof row.trit_shadow === 'object' ? row.trit_shadow : null;
    if (!shadow) continue;
    const day = isDateStr(row.date) ? String(row.date) : dateFromTs(row.ts);
    if (!inWindow(day, startDate, endDate)) continue;

    const legacyAction = String(row.action || '').trim();
    const shadowAction = String(shadow.action || '').trim();
    const divergence = shadow.divergence === true || (!!legacyAction && !!shadowAction && legacyAction !== shadowAction);
    const reason = String(shadow.reason || row.reason || '').trim() || 'unknown';
    const belief = shadow.belief && typeof shadow.belief === 'object' ? shadow.belief : {};
    const trit = Number(belief.trit || 0);
    const confidence = Number(belief.confidence);
    const tsMs = Date.parse(String(row.ts || ''));

    summary.total_decisions += 1;
    if (divergence) summary.divergence_count += 1;
    addCount(reasons, reason);
    if (trit === -1) summary.belief_trits.pain += 1;
    else if (trit === 1) summary.belief_trits.ok += 1;
    else summary.belief_trits.neutral += 1;
    if (Number.isFinite(confidence)) {
      confidenceSum += confidence;
      confidenceCount += 1;
    }
    if (Number.isFinite(tsMs) && tsMs > latestMs) latestMs = tsMs;
  }

  summary.divergence_rate = summary.total_decisions > 0
    ? Number((summary.divergence_count / summary.total_decisions).toFixed(4))
    : 0;
  summary.confidence_avg = confidenceCount > 0 ? Number((confidenceSum / confidenceCount).toFixed(4)) : null;
  summary.top_reasons = topCounts(reasons, 8).map((row) => ({ reason: row.key, count: row.count }));
  summary.last_ts = latestMs > 0 ? new Date(latestMs).toISOString() : null;
  return summary;
}

function summarizeOverall(
  strategyMode: AnyObj,
  driftTarget: AnyObj,
  thresholds: { min_samples: number; warn_divergence_rate: number; critical_divergence_rate: number; max_divergence_rate: number | null }
) {
  const totalDecisions = Number(strategyMode.total_decisions || 0) + Number(driftTarget.total_decisions || 0);
  const divergenceCount = Number(strategyMode.divergence_count || 0) + Number(driftTarget.divergence_count || 0);
  const divergenceRate = totalDecisions > 0 ? Number((divergenceCount / totalDecisions).toFixed(4)) : 0;
  const confidenceRows = [strategyMode.confidence_avg, driftTarget.confidence_avg]
    .map((v) => Number(v))
    .filter((v) => Number.isFinite(v));
  const confidenceAvg = confidenceRows.length > 0
    ? Number((confidenceRows.reduce((acc, v) => acc + v, 0) / confidenceRows.length).toFixed(4))
    : null;

  let status = 'stable';
  if (totalDecisions < Number(thresholds.min_samples || 0)) {
    status = 'insufficient_samples';
  } else if (divergenceRate >= Number(thresholds.critical_divergence_rate || 1)) {
    status = 'critical';
  } else if (divergenceRate >= Number(thresholds.warn_divergence_rate || 1)) {
    status = 'warn';
  }

  const gateEnabled = thresholds.max_divergence_rate != null;
  let gatePass = true;
  let gateReason = gateEnabled ? 'within_limit' : 'disabled';
  if (gateEnabled) {
    if (totalDecisions < Number(thresholds.min_samples || 0)) {
      gateReason = 'insufficient_samples';
      gatePass = true;
    } else if (divergenceRate > Number(thresholds.max_divergence_rate || 0)) {
      gateReason = 'divergence_rate_exceeds_limit';
      gatePass = false;
    }
  }

  return {
    status,
    total_decisions: totalDecisions,
    divergence_count: divergenceCount,
    divergence_rate: divergenceRate,
    confidence_avg: confidenceAvg,
    gate: {
      enabled: gateEnabled,
      pass: gatePass,
      reason: gateReason,
      max_divergence_rate: thresholds.max_divergence_rate
    }
  };
}

function dateRange(endDate: string, days: number) {
  const out = [];
  for (let i = Math.max(1, Number(days || 1)) - 1; i >= 0; i -= 1) {
    out.push(dateShift(endDate, -i));
  }
  return out;
}

function readHealthReportByDate(dateStr: string, window: 'daily' | 'weekly' = 'daily') {
  const candidates = [
    path.join(HEALTH_REPORTS_DIR, `${dateStr}.${window}.json`),
    path.join(HEALTH_REPORTS_DIR, `${dateStr}__${window}.json`)
  ];
  for (const fp of candidates) {
    const row = readJson(fp, null);
    if (row && typeof row === 'object') return row;
  }
  return null;
}

function metricsFromHealthReports(endDate: string, days: number) {
  const dates = dateRange(endDate, days);
  let safetyRegressions = 0;
  let yieldSum = 0;
  let yieldCount = 0;
  let driftSum = 0;
  let driftCount = 0;
  for (const d of dates) {
    const daily = readHealthReportByDate(d, 'daily');
    if (!daily) continue;
    const slo = daily.slo && typeof daily.slo === 'object' ? daily.slo : {};
    safetyRegressions += Math.max(0, Number(slo.critical_count || 0));
    const verifiedRate = Number(
      daily
      && daily.autonomy_receipts
      && daily.autonomy_receipts.receipts
      && daily.autonomy_receipts.receipts.combined
      && daily.autonomy_receipts.receipts.combined.verified_rate
    );
    if (Number.isFinite(verifiedRate)) {
      yieldSum += verifiedRate;
      yieldCount += 1;
    }
    const driftRate = Number(
      daily
      && daily.drift_target_governor
      && daily.drift_target_governor.decision
      && daily.drift_target_governor.decision.drift_rate
    );
    if (Number.isFinite(driftRate)) {
      driftSum += driftRate;
      driftCount += 1;
    }
  }
  return {
    safety_regressions: safetyRegressions,
    avg_yield_rate: yieldCount > 0 ? Number((yieldSum / yieldCount).toFixed(4)) : null,
    avg_drift_rate: driftCount > 0 ? Number((driftSum / driftCount).toFixed(4)) : null
  };
}

function evaluateSuccessCriteria(
  endDate: string,
  days: number,
  summary: AnyObj
) {
  const criteria = loadTritShadowSuccessCriteria();
  const targets = criteria && criteria.targets && typeof criteria.targets === 'object'
    ? criteria.targets
    : {};
  const baseline = criteria && criteria.baseline && typeof criteria.baseline === 'object'
    ? criteria.baseline
    : {};
  const observed = metricsFromHealthReports(endDate, days);
  const baselineYield = Number(baseline.yield_rate);
  const baselineDrift = Number(baseline.drift_rate);
  const yieldLift = Number.isFinite(observed.avg_yield_rate) && Number.isFinite(baselineYield)
    ? Number((observed.avg_yield_rate - baselineYield).toFixed(4))
    : null;
  const driftDelta = Number.isFinite(observed.avg_drift_rate) && Number.isFinite(baselineDrift)
    ? Number((observed.avg_drift_rate - baselineDrift).toFixed(4))
    : null;

  const maxDivergenceRate = clampRate(targets.max_divergence_rate, 0.05);
  const minDecisionsForDivergence = clampInt(targets.min_decisions_for_divergence, 1, 100000, 30);
  const divergencePass = Number(summary && summary.total_decisions || 0) >= minDecisionsForDivergence
    ? Number(summary && summary.divergence_rate || 0) <= maxDivergenceRate
    : true;

  const maxSafetyRegressions = Math.max(0, Number(targets.max_safety_regressions || 0));
  const safetyPass = Number(observed.safety_regressions || 0) <= maxSafetyRegressions;

  const driftNonIncreasing = targets.drift_non_increasing !== false;
  const driftPass = !driftNonIncreasing
    || driftDelta == null
    || driftDelta <= 0;

  const minYieldLift = Number(targets.min_yield_lift || 0);
  const yieldPass = yieldLift == null || yieldLift >= minYieldLift;

  const checks = {
    divergence_rate: {
      pass: divergencePass,
      value: Number(summary && summary.divergence_rate || 0),
      target: `<=${maxDivergenceRate}`,
      min_decisions: minDecisionsForDivergence,
      decisions: Number(summary && summary.total_decisions || 0)
    },
    safety_regressions: {
      pass: safetyPass,
      value: Number(observed.safety_regressions || 0),
      target: `<=${maxSafetyRegressions}`
    },
    drift_non_increasing: {
      pass: driftPass,
      value: driftDelta,
      target: '<=0'
    },
    yield_lift: {
      pass: yieldPass,
      value: yieldLift,
      target: `>=${minYieldLift}`
    }
  };
  const failed = Object.entries(checks)
    .filter(([, row]) => row && typeof row === 'object' && row.pass === false)
    .map(([name]) => name);

  return {
    version: String(criteria && criteria.version || '1.0'),
    checks,
    failed_checks: failed,
    pass: failed.length === 0,
    observed: {
      avg_yield_rate: observed.avg_yield_rate,
      avg_drift_rate: observed.avg_drift_rate,
      safety_regressions: observed.safety_regressions,
      yield_lift: yieldLift,
      drift_delta: driftDelta
    },
    baseline
  };
}

function buildReport(date: string, days: number, maxDivergenceRate: number | null) {
  const thresholds = {
    min_samples: DEFAULT_MIN_SAMPLES,
    warn_divergence_rate: DEFAULT_WARN_RATE,
    critical_divergence_rate: DEFAULT_CRITICAL_RATE,
    max_divergence_rate: maxDivergenceRate
  };
  const strategyMode = summarizeStrategyMode(date, days);
  const driftTarget = summarizeDriftTarget(date, days);
  const overall = summarizeOverall(strategyMode, driftTarget, thresholds);
  const successCriteria = evaluateSuccessCriteria(date, days, overall);

  return {
    ok: true,
    type: 'trit_shadow_report',
    ts: nowIso(),
    date,
    days,
    window: {
      start_date: dateShift(date, -(days - 1)),
      end_date: date
    },
    thresholds,
    summary: overall,
    success_criteria: successCriteria,
    sources: {
      strategy_mode: strategyMode,
      drift_target: driftTarget
    }
  };
}

function cmdRun(args: AnyObj, opts: { write: boolean }) {
  const date = isDateStr(args._[1]) ? String(args._[1]) : todayStr();
  const days = clampInt(args.days, 1, 120, 14);
  const maxDivergenceRate = clampOptionalRate(
    args['max-divergence-rate'] != null ? args['max-divergence-rate'] : DEFAULT_MAX_DIVERGENCE_RATE
  );
  const report = buildReport(date, days, maxDivergenceRate);

  const out: AnyObj = { ...report };
  if (opts.write) {
    ensureDir(REPORT_DIR);
    const reportPath = path.join(REPORT_DIR, `${date}.json`);
    writeJson(reportPath, report);
    appendJsonl(HISTORY_PATH, report);
    out.report_path = reportPath;
    out.history_path = HISTORY_PATH;
  }

  process.stdout.write(`${JSON.stringify(out)}\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim();
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help' || args.help === true) {
    usage();
    return;
  }
  if (cmd === 'run') {
    cmdRun(args, { write: true });
    return;
  }
  if (cmd === 'status') {
    cmdRun(args, { write: false });
    return;
  }
  usage();
  process.exitCode = 2;
}

if (require.main === module) {
  try {
    main();
  } catch (err: any) {
    process.stdout.write(JSON.stringify({ ok: false, error: String(err && err.message || err || 'trit_shadow_report_failed') }) + '\n');
    process.exit(1);
  }
}

module.exports = {
  summarizeStrategyMode,
  summarizeDriftTarget,
  summarizeOverall,
  buildReport
};
