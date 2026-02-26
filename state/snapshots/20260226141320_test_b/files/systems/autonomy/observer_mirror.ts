#!/usr/bin/env node
'use strict';
export {};

/**
 * observer_mirror.js
 *
 * Read-only observer layer that summarizes autonomy health in plain language.
 *
 * Usage:
 *   node systems/autonomy/observer_mirror.js run [YYYY-MM-DD] [--days=1]
 *   node systems/autonomy/observer_mirror.js status [YYYY-MM-DD]
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const RUNS_DIR = process.env.OBSERVER_MIRROR_RUNS_DIR
  ? path.resolve(process.env.OBSERVER_MIRROR_RUNS_DIR)
  : path.join(ROOT, 'state', 'autonomy', 'runs');
const SIM_DIR = process.env.OBSERVER_MIRROR_SIM_DIR
  ? path.resolve(process.env.OBSERVER_MIRROR_SIM_DIR)
  : path.join(ROOT, 'state', 'autonomy', 'simulations');
const INTROSPECTION_DIR = process.env.OBSERVER_MIRROR_INTROSPECTION_DIR
  ? path.resolve(process.env.OBSERVER_MIRROR_INTROSPECTION_DIR)
  : path.join(ROOT, 'state', 'autonomy', 'fractal', 'introspection');
const OUT_DIR = process.env.OBSERVER_MIRROR_OUT_DIR
  ? path.resolve(process.env.OBSERVER_MIRROR_OUT_DIR)
  : path.join(ROOT, 'state', 'autonomy', 'observer_mirror');
const HISTORY_PATH = path.join(OUT_DIR, 'history.jsonl');
const LATEST_PATH = path.join(OUT_DIR, 'latest.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/autonomy/observer_mirror.js run [YYYY-MM-DD] [--days=1]');
  console.log('  node systems/autonomy/observer_mirror.js status [YYYY-MM-DD]');
}

function parseArgs(argv) {
  const out = { _: [] };
  for (const arg of argv) {
    if (!String(arg || '').startsWith('--')) {
      out._.push(String(arg || ''));
      continue;
    }
    const idx = arg.indexOf('=');
    if (idx === -1) out[String(arg || '').slice(2)] = true;
    else out[String(arg || '').slice(2, idx)] = String(arg || '').slice(idx + 1);
  }
  return out;
}

function nowIso() {
  return new Date().toISOString();
}

function dateArgOrToday(v) {
  const raw = String(v || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  return nowIso().slice(0, 10);
}

function clampInt(v, lo, hi, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

function safeNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function readJsonl(filePath) {
  try {
    if (!fs.existsSync(filePath)) return [];
    return fs.readFileSync(filePath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          const row = JSON.parse(line);
          return row && typeof row === 'object' ? row : null;
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeJsonAtomic(filePath, value) {
  ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function appendJsonl(filePath, row) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function shiftDate(dateStr, deltaDays) {
  const base = new Date(`${dateStr}T00:00:00.000Z`);
  if (Number.isNaN(base.getTime())) return dateStr;
  base.setUTCDate(base.getUTCDate() + Number(deltaDays || 0));
  return base.toISOString().slice(0, 10);
}

function windowDates(dateStr, days) {
  const out = [];
  for (let i = days - 1; i >= 0; i -= 1) out.push(shiftDate(dateStr, -i));
  return out;
}

function countMapToTopRows(mapObj, maxRows = 6) {
  const rows = Object.entries(mapObj || {}).map(([key, count]) => ({
    key: String(key || ''),
    count: Number(count || 0)
  }));
  rows.sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  return rows.slice(0, maxRows);
}

function isPolicyHoldResult(result) {
  const normalized = String(result || '').trim().toLowerCase();
  if (!normalized) return false;
  return normalized === 'policy_hold'
    || normalized.startsWith('no_candidates_policy_')
    || normalized.startsWith('stop_init_gate_')
    || normalized.startsWith('stop_repeat_gate_');
}

function summarizeRuns(dateStr, days) {
  const counts = {
    runs: 0,
    executed: 0,
    shipped: 0,
    no_change: 0,
    policy_holds: 0,
    stops: 0
  };
  const byType = {};
  const byResult = {};
  const byObjective = {};
  const rows = [];
  for (const day of windowDates(dateStr, days)) {
    for (const row of readJsonl(path.join(RUNS_DIR, `${day}.jsonl`))) {
      if (String(row && row.type || '') !== 'autonomy_run') continue;
      rows.push(row);
      counts.runs += 1;
      const result = String(row.result || '').trim().toLowerCase();
      const outcome = String(row.outcome || '').trim().toLowerCase();
      const pType = String(row.proposal_type || 'unknown').trim().toLowerCase() || 'unknown';
      const objectiveId = String(row.objective_id || '').trim().toLowerCase() || 'none';
      byType[pType] = Number(byType[pType] || 0) + 1;
      byResult[result || 'unknown'] = Number(byResult[result || 'unknown'] || 0) + 1;
      byObjective[objectiveId] = Number(byObjective[objectiveId] || 0) + 1;

      if (result === 'executed') counts.executed += 1;
      if (outcome === 'shipped') counts.shipped += 1;
      if (outcome === 'no_change') counts.no_change += 1;
      if (isPolicyHoldResult(result)) counts.policy_holds += 1;
      if (result.startsWith('stop_')) counts.stops += 1;
    }
  }

  const shipRate = counts.executed > 0 ? counts.shipped / counts.executed : 0;
  const holdRate = counts.runs > 0 ? counts.policy_holds / counts.runs : 0;
  const noChangeRate = counts.executed > 0 ? counts.no_change / counts.executed : 0;

  return {
    counts,
    rates: {
      ship_rate: Number(shipRate.toFixed(4)),
      hold_rate: Number(holdRate.toFixed(4)),
      no_change_rate: Number(noChangeRate.toFixed(4))
    },
    top: {
      proposal_types: countMapToTopRows(byType, 6),
      results: countMapToTopRows(byResult, 6),
      objectives: countMapToTopRows(byObjective, 6)
    },
    sample_size: rows.length
  };
}

function simulationSnapshot(dateStr) {
  const payload = readJson(path.join(SIM_DIR, `${dateStr}.json`), {});
  const checks = payload && payload.checks_effective && typeof payload.checks_effective === 'object'
    ? payload.checks_effective
    : (payload && payload.checks && typeof payload.checks === 'object' ? payload.checks : {});
  const drift = safeNumber(checks && checks.drift_rate && checks.drift_rate.value, NaN);
  const yieldRate = safeNumber(checks && checks.yield_rate && checks.yield_rate.value, NaN);
  return {
    drift_rate: Number.isFinite(drift) ? Number(drift.toFixed(6)) : null,
    yield_rate: Number.isFinite(yieldRate) ? Number(yieldRate.toFixed(6)) : null
  };
}

function introspectionSnapshot(dateStr) {
  const payload = readJson(path.join(INTROSPECTION_DIR, `${dateStr}.json`), {});
  const snap = payload && payload.snapshot && typeof payload.snapshot === 'object'
    ? payload.snapshot
    : {};
  return {
    queue_pressure: String(snap && snap.queue && snap.queue.pressure || 'unknown').trim().toLowerCase() || 'unknown',
    autopause_active: !!(snap && snap.autopause && snap.autopause.active === true),
    restructure_candidates: Array.isArray(payload && payload.restructure_candidates)
      ? payload.restructure_candidates.length
      : 0
  };
}

function observerMood(runSummary, sim, introspection) {
  const drift = Number(sim && sim.drift_rate);
  const yieldRate = Number(sim && sim.yield_rate);
  const holdRate = Number(runSummary && runSummary.rates && runSummary.rates.hold_rate || 0);
  const queuePressure = String(introspection && introspection.queue_pressure || 'unknown');

  if (
    (Number.isFinite(drift) && drift > 0.05)
    || holdRate >= 0.45
    || queuePressure === 'critical'
    || (Number.isFinite(yieldRate) && yieldRate < 0.58)
  ) return 'strained';
  if (
    (Number.isFinite(drift) && drift <= 0.03)
    && holdRate < 0.28
    && (queuePressure === 'normal' || queuePressure === 'elevated')
    && (!Number.isFinite(yieldRate) || yieldRate >= 0.65)
  ) return 'stable';
  return 'guarded';
}

function observerRecommendation(mood, introspection) {
  const queuePressure = String(introspection && introspection.queue_pressure || 'unknown');
  if (mood === 'strained' && queuePressure === 'critical') return 'drain backlog before adding new adaptive experiments';
  if (mood === 'strained') return 'tighten admission and defer medium-risk changes';
  if (mood === 'guarded') return 'hold policy steady and monitor non-yield concentration';
  return 'maintain current policy envelope';
}

function observerStatement(mood, runs, sim, introspection) {
  const counts = runs && runs.counts ? runs.counts : {};
  const drift = sim && sim.drift_rate != null ? Number(sim.drift_rate).toFixed(3) : 'n/a';
  const yieldRate = sim && sim.yield_rate != null ? Number(sim.yield_rate).toFixed(3) : 'n/a';
  const queuePressure = String(introspection && introspection.queue_pressure || 'unknown');
  return (
    `observer=${mood}; drift=${drift}; yield=${yieldRate}; queue=${queuePressure}; ` +
    `executed=${Number(counts.executed || 0)}; shipped=${Number(counts.shipped || 0)}; holds=${Number(counts.policy_holds || 0)}`
  );
}

function outputPath(dateStr) {
  return path.join(OUT_DIR, `${dateStr}.json`);
}

function runObserver(dateStr, args) {
  const days = clampInt(args.days, 1, 14, 1);
  const runs = summarizeRuns(dateStr, days);
  const sim = simulationSnapshot(dateStr);
  const introspection = introspectionSnapshot(dateStr);
  const mood = observerMood(runs, sim, introspection);
  const recommendation = observerRecommendation(mood, introspection);
  const statement = observerStatement(mood, runs, sim, introspection);

  const payload = {
    ok: true,
    type: 'observer_mirror_run',
    ts: nowIso(),
    date: dateStr,
    window_days: days,
    summary: runs,
    simulation: sim,
    introspection,
    observer: {
      mood,
      statement,
      recommendation
    }
  };

  const fp = outputPath(dateStr);
  writeJsonAtomic(fp, payload);
  writeJsonAtomic(LATEST_PATH, payload);
  appendJsonl(HISTORY_PATH, {
    ts: payload.ts,
    type: payload.type,
    date: payload.date,
    mood: mood,
    ship_rate: runs.rates.ship_rate,
    hold_rate: runs.rates.hold_rate,
    drift_rate: sim.drift_rate,
    yield_rate: sim.yield_rate,
    queue_pressure: introspection.queue_pressure
  });

  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: payload.type,
    date: dateStr,
    mood: mood,
    drift_rate: sim.drift_rate,
    yield_rate: sim.yield_rate,
    ship_rate: runs.rates.ship_rate,
    hold_rate: runs.rates.hold_rate,
    queue_pressure: introspection.queue_pressure,
    output_path: path.relative(ROOT, fp).replace(/\\/g, '/')
  })}\n`);
}

function statusObserver(dateStr) {
  const payload = readJson(outputPath(dateStr), null) || readJson(LATEST_PATH, null);
  if (!payload || typeof payload !== 'object') {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      type: 'observer_mirror_status',
      date: dateStr,
      error: 'observer_snapshot_missing'
    })}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'observer_mirror_status',
    date: payload.date || dateStr,
    ts: payload.ts || null,
    mood: payload.observer && payload.observer.mood ? payload.observer.mood : null,
    statement: payload.observer && payload.observer.statement ? payload.observer.statement : null,
    recommendation: payload.observer && payload.observer.recommendation ? payload.observer.recommendation : null
  })}\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim().toLowerCase();
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    usage();
    return;
  }
  const dateStr = dateArgOrToday(args._[1]);
  if (cmd === 'run') return runObserver(dateStr, args);
  if (cmd === 'status') return statusObserver(dateStr);
  usage();
  process.exitCode = 2;
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      type: 'observer_mirror',
      error: String(err && err.message ? err.message : err || 'observer_mirror_failed')
    })}\n`);
    process.exit(1);
  }
}

module.exports = {
  summarizeRuns,
  simulationSnapshot,
  introspectionSnapshot,
  observerMood
};
