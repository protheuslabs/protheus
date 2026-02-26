#!/usr/bin/env node
'use strict';
export {};

/**
 * trit_shadow_replay_calibration.js
 *
 * Replay Trit shadow calls against realized outcomes and emit confidence calibration metrics.
 *
 * Usage:
 *   node systems/autonomy/trit_shadow_replay_calibration.js run [YYYY-MM-DD] [--days=N] [--lookahead-hours=N]
 *   node systems/autonomy/trit_shadow_replay_calibration.js status [YYYY-MM-DD] [--days=N] [--lookahead-hours=N]
 */

const fs = require('fs');
const path = require('path');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const STRATEGY_MODE_LOG_PATH = process.env.AUTONOMY_TRIT_SHADOW_STRATEGY_LOG_PATH
  ? path.resolve(process.env.AUTONOMY_TRIT_SHADOW_STRATEGY_LOG_PATH)
  : path.join(ROOT, 'state', 'autonomy', 'strategy_mode_changes.jsonl');
const DRIFT_STATE_PATH = process.env.AUTONOMY_TRIT_SHADOW_DRIFT_STATE_PATH
  ? path.resolve(process.env.AUTONOMY_TRIT_SHADOW_DRIFT_STATE_PATH)
  : path.join(ROOT, 'state', 'autonomy', 'drift_target_governor_state.json');
const RUNS_DIR = process.env.AUTONOMY_TRIT_SHADOW_RUNS_DIR
  ? path.resolve(process.env.AUTONOMY_TRIT_SHADOW_RUNS_DIR)
  : path.join(ROOT, 'state', 'autonomy', 'runs');
const REPORT_DIR = process.env.AUTONOMY_TRIT_SHADOW_CALIBRATION_DIR
  ? path.resolve(process.env.AUTONOMY_TRIT_SHADOW_CALIBRATION_DIR)
  : path.join(ROOT, 'state', 'autonomy', 'trit_shadow_calibration');
const HISTORY_PATH = path.join(REPORT_DIR, 'history.jsonl');

function usage() {
  console.log('Usage:');
  console.log('  node systems/autonomy/trit_shadow_replay_calibration.js run [YYYY-MM-DD] [--days=N] [--lookahead-hours=N]');
  console.log('  node systems/autonomy/trit_shadow_replay_calibration.js status [YYYY-MM-DD] [--days=N] [--lookahead-hours=N]');
}

function parseArgs(argv: string[]) {
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

function isDateStr(v: unknown) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
}

function clampInt(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

function clampRate(v: unknown, fallback = 0) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function roundTo(v: unknown, digits = 4) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  const factor = Math.pow(10, digits);
  return Math.round(n * factor) / factor;
}

function parseTsMs(value: unknown) {
  const ms = Date.parse(String(value || ''));
  return Number.isFinite(ms) ? ms : null;
}

function dateShift(dateStr: string, deltaDays: number) {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + Number(deltaDays || 0));
  return d.toISOString().slice(0, 10);
}

function dateRange(startDate: string, endDate: string) {
  const out: string[] = [];
  if (!isDateStr(startDate) || !isDateStr(endDate) || startDate > endDate) return out;
  let cur = startDate;
  while (cur <= endDate) {
    out.push(cur);
    cur = dateShift(cur, 1);
  }
  return out;
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

function readJsonl(filePath: string) {
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
  const out = [];
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

function writeJson(filePath: string, value: AnyObj) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function appendJsonl(filePath: string, value: AnyObj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, 'utf8');
}

function tritFromRunResult(result: string) {
  const r = String(result || '').trim().toLowerCase();
  if (!r) return 0;
  if (/^(executed|shipped|mode_changed)$/.test(r)) return 1;
  if (/(stop|blocked|deny|denied|fail|failed|error|halt|violation|autopause|degraded|unavailable)/.test(r)) return -1;
  if (/(preview|score_only|evidence|manual|noop|hold|cooldown)/.test(r)) return 0;
  return 0;
}

function aggregateTrit(values: number[]) {
  const rows = Array.isArray(values) ? values : [];
  let pos = 0;
  let neg = 0;
  for (const row of rows) {
    if (Number(row) > 0) pos += 1;
    else if (Number(row) < 0) neg += 1;
  }
  if (pos > neg) return 1;
  if (neg > pos) return -1;
  return 0;
}

function collectRunsInWindow(startMs: number, endMs: number, strategyId: string | null) {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return [];
  const startDate = new Date(startMs).toISOString().slice(0, 10);
  const endDate = new Date(endMs).toISOString().slice(0, 10);
  const days = dateRange(startDate, endDate);
  const out = [];
  for (const d of days) {
    const fp = path.join(RUNS_DIR, `${d}.jsonl`);
    const rows = readJsonl(fp);
    for (const row of rows) {
      if (!row || String(row.type || '') !== 'autonomy_run') continue;
      if (strategyId && String(row.strategy_id || '') && String(row.strategy_id || '') !== strategyId) continue;
      const tsMs = parseTsMs(row.ts);
      if (tsMs == null || tsMs < startMs || tsMs > endMs) continue;
      out.push(row);
    }
  }
  return out;
}

function updateSourceReliability(sourceStats: AnyObj, topSources: any[], hit: number, confidence: number) {
  const tops = Array.isArray(topSources) ? topSources : [];
  for (const row of tops) {
    if (!row || typeof row !== 'object') continue;
    const source = String(row.source || '').trim();
    if (!source) continue;
    const weight = Math.max(0.1, Number(row.weighted || 1));
    const rec = sourceStats[source] && typeof sourceStats[source] === 'object'
      ? sourceStats[source]
      : { source, weighted_hits: 0, weighted_total: 0, confidence_weighted: 0, samples: 0 };
    rec.weighted_hits += Number(hit || 0) * weight;
    rec.weighted_total += weight;
    rec.confidence_weighted += clampRate(confidence, 0.5) * weight;
    rec.samples += 1;
    sourceStats[source] = rec;
  }
}

function finalizeSourceReliability(sourceStats: AnyObj) {
  return Object.values(sourceStats || {})
    .map((row: any) => {
      const weightedTotal = Number(row.weighted_total || 0);
      return {
        source: String(row.source || ''),
        samples: Number(row.samples || 0),
        reliability: weightedTotal > 0 ? roundTo(Number(row.weighted_hits || 0) / weightedTotal, 4) : null,
        avg_confidence: weightedTotal > 0 ? roundTo(Number(row.confidence_weighted || 0) / weightedTotal, 4) : null
      };
    })
    .filter((row: any) => !!row.source)
    .sort((a: any, b: any) => (Number(b.samples || 0) - Number(a.samples || 0)) || a.source.localeCompare(b.source))
    .slice(0, 120);
}

function summarizeCalibration(rows: AnyObj[]) {
  const total = rows.length;
  const known = rows.filter((row) => Number(row.observed_trit) !== 0).length;
  const hits = rows.filter((row) => row.hit === true).length;
  const accuracy = total > 0 ? hits / total : 0;
  const avgConfidence = total > 0
    ? rows.reduce((acc, row) => acc + clampRate(row.confidence, 0), 0) / total
    : 0;
  const brier = total > 0
    ? rows.reduce((acc, row) => {
      const conf = clampRate(row.confidence, 0);
      const obs = row.hit === true ? 1 : 0;
      return acc + Math.pow(conf - obs, 2);
    }, 0) / total
    : 0;

  const bins = [];
  for (let i = 0; i < 5; i += 1) bins.push({ idx: i, lo: i * 0.2, hi: (i + 1) * 0.2, n: 0, hit_sum: 0, conf_sum: 0 });
  for (const row of rows) {
    const conf = clampRate(row.confidence, 0);
    const idx = Math.min(4, Math.max(0, Math.floor(conf * 5)));
    const bin = bins[idx];
    bin.n += 1;
    bin.hit_sum += row.hit === true ? 1 : 0;
    bin.conf_sum += conf;
  }
  let ece = 0;
  for (const bin of bins) {
    if (bin.n <= 0 || total <= 0) continue;
    const acc = bin.hit_sum / bin.n;
    const conf = bin.conf_sum / bin.n;
    ece += (bin.n / total) * Math.abs(acc - conf);
  }

  return {
    total_events: total,
    observed_non_neutral_events: known,
    hit_count: hits,
    accuracy: roundTo(accuracy, 4),
    avg_confidence: roundTo(avgConfidence, 4),
    brier_score: roundTo(brier, 4),
    expected_calibration_error: roundTo(ece, 4)
  };
}

function strategyRowsForWindow(endDate: string, days: number, lookaheadHours: number, sourceStats: AnyObj) {
  const startDate = dateShift(endDate, -(days - 1));
  const rows = readJsonl(STRATEGY_MODE_LOG_PATH);
  const out = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const shadow = row.trit_shadow && typeof row.trit_shadow === 'object' ? row.trit_shadow : null;
    if (!shadow || !shadow.belief || typeof shadow.belief !== 'object') continue;
    const tsMs = parseTsMs(row.ts);
    if (tsMs == null) continue;
    const day = new Date(tsMs).toISOString().slice(0, 10);
    if (!isDateStr(day) || day < startDate || day > endDate) continue;

    const predictedTrit = Number(shadow.belief.trit || 0);
    const confidence = clampRate(shadow.belief.confidence, 0);
    const strategyId = row.strategy_id ? String(row.strategy_id) : null;
    const windowEndMs = tsMs + (Math.max(1, Number(lookaheadHours || 24)) * 60 * 60 * 1000);
    const runs = collectRunsInWindow(tsMs, windowEndMs, strategyId);
    const observedTrit = aggregateTrit(runs.map((r) => tritFromRunResult(String(r.result || ''))));
    const hit = predictedTrit === observedTrit;
    updateSourceReliability(sourceStats, shadow.top_sources, hit ? 1 : 0, confidence);
    out.push({
      ts: row.ts,
      source: 'strategy_mode_governor',
      predicted_trit: predictedTrit,
      observed_trit: observedTrit,
      confidence: roundTo(confidence, 4),
      hit
    });
  }
  return out;
}

function driftRowsForWindow(endDate: string, days: number, sourceStats: AnyObj) {
  const startDate = dateShift(endDate, -(days - 1));
  const state = readJson(DRIFT_STATE_PATH, {});
  const history = Array.isArray(state && state.history) ? state.history : [];
  const out = [];
  const sorted = history
    .filter((row) => row && typeof row === 'object')
    .sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')));
  for (let i = 0; i < sorted.length; i += 1) {
    const row = sorted[i];
    const shadow = row.trit_shadow && typeof row.trit_shadow === 'object' ? row.trit_shadow : null;
    if (!shadow || !shadow.belief || typeof shadow.belief !== 'object') continue;
    const tsMs = parseTsMs(row.ts);
    if (tsMs == null) continue;
    const day = new Date(tsMs).toISOString().slice(0, 10);
    if (!isDateStr(day) || day < startDate || day > endDate) continue;

    const next = sorted[i + 1] && typeof sorted[i + 1] === 'object' ? sorted[i + 1] : null;
    const currentDrift = Number(row.drift_rate);
    const nextDrift = next ? Number(next.drift_rate) : NaN;
    let observedTrit = 0;
    if (Number.isFinite(currentDrift) && Number.isFinite(nextDrift)) {
      if (nextDrift < currentDrift - 1e-9) observedTrit = 1;
      else if (nextDrift > currentDrift + 1e-9) observedTrit = -1;
      else observedTrit = 0;
    }
    const predictedTrit = Number(shadow.belief.trit || 0);
    const confidence = clampRate(shadow.belief.confidence, 0);
    const hit = predictedTrit === observedTrit;
    updateSourceReliability(sourceStats, shadow.top_sources, hit ? 1 : 0, confidence);
    out.push({
      ts: row.ts,
      source: 'drift_target_governor',
      predicted_trit: predictedTrit,
      observed_trit: observedTrit,
      confidence: roundTo(confidence, 4),
      hit
    });
  }
  return out;
}

function buildReport(endDate: string, days: number, lookaheadHours: number) {
  const sourceStats = {};
  const strategyRows = strategyRowsForWindow(endDate, days, lookaheadHours, sourceStats);
  const driftRows = driftRowsForWindow(endDate, days, sourceStats);
  const allRows = strategyRows.concat(driftRows);

  return {
    ok: true,
    type: 'trit_shadow_replay_calibration',
    ts: nowIso(),
    date: endDate,
    days,
    lookahead_hours: lookaheadHours,
    summary: summarizeCalibration(allRows),
    by_governor: {
      strategy_mode: summarizeCalibration(strategyRows),
      drift_target: summarizeCalibration(driftRows)
    },
    source_reliability: finalizeSourceReliability(sourceStats)
  };
}

function cmdRun(args: AnyObj, opts: { write: boolean }) {
  const date = isDateStr(args._[1]) ? String(args._[1]) : todayStr();
  const days = clampInt(args.days, 1, 120, 28);
  const lookaheadHours = clampInt(args['lookahead-hours'], 1, 168, 24);
  const report = buildReport(date, days, lookaheadHours);
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
    process.stdout.write(JSON.stringify({ ok: false, error: String(err && err.message || err || 'trit_shadow_replay_calibration_failed') }) + '\n');
    process.exit(1);
  }
}

module.exports = {
  buildReport,
  summarizeCalibration
};
