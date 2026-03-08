#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_AUTONOMY_DIR = fs.existsSync(path.join(ROOT, 'local', 'state', 'autonomy'))
  ? path.join(ROOT, 'local', 'state', 'autonomy')
  : path.join(ROOT, 'state', 'autonomy');
const AUTONOMY_DIR = process.env.AUTONOMY_STATE_DIR
  ? path.resolve(process.env.AUTONOMY_STATE_DIR)
  : DEFAULT_AUTONOMY_DIR;
const CANDIDATES_DIR = process.env.AUTONOMY_AUTOPHAGY_CANDIDATES_DIR
  ? path.resolve(process.env.AUTONOMY_AUTOPHAGY_CANDIDATES_DIR)
  : path.join(AUTONOMY_DIR, 'autophagy_candidates');
const BASELINE_PATH = process.env.AUTONOMY_AUTOPHAGY_BASELINE_PATH
  ? path.resolve(process.env.AUTONOMY_AUTOPHAGY_BASELINE_PATH)
  : path.join(AUTONOMY_DIR, 'autophagy_baseline.json');
const SIM_OUTPUT_DIR = path.join(AUTONOMY_DIR, 'simulations');
const REPORT_DIR = process.env.AUTONOMY_AUTOPHAGY_REPLAY_REPORTS_DIR
  ? path.resolve(process.env.AUTONOMY_AUTOPHAGY_REPLAY_REPORTS_DIR)
  : path.join(AUTONOMY_DIR, 'autophagy_replay');

function usage() {
  console.log('Usage:');
  console.log('  node systems/autonomy/non_yield_replay.js run [YYYY-MM-DD] [--days=N] [--candidates=<path>] [--baseline=<path>] [--simulation=<path>] [--write=1|0]');
  console.log('  node systems/autonomy/non_yield_replay.js status [YYYY-MM-DD] [--days=N] [--candidates=<path>] [--baseline=<path>] [--simulation=<path>]');
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

function isDateStr(v) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function resolveDate(args) {
  const first = String(args._[1] || '').trim();
  if (isDateStr(first)) return first;
  const second = String(args._[0] || '').trim();
  if (isDateStr(second)) return second;
  return todayStr();
}

function resolvePath(raw, fallbackAbs) {
  const v = String(raw || '').trim();
  if (!v) return fallbackAbs;
  return path.isAbsolute(v) ? v : path.join(ROOT, v);
}

function toInt(v, fallback, lo = 1, hi = 365) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

function clamp(v, lo, hi) {
  if (!Number.isFinite(v)) return lo;
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(fp) {
  return JSON.parse(fs.readFileSync(fp, 'utf8'));
}

function defaultSimulationPath(dateStr) {
  return path.join(SIM_OUTPUT_DIR, `${dateStr}.json`);
}

function latestCandidatePath() {
  if (!fs.existsSync(CANDIDATES_DIR)) return null;
  const files = fs.readdirSync(CANDIDATES_DIR)
    .filter((name) => /^\d{4}-W\d{2}\.json$/.test(name))
    .sort();
  if (!files.length) return null;
  return path.join(CANDIDATES_DIR, files[files.length - 1]);
}

function loadSimulation(dateStr, days, simulationPath) {
  if (fs.existsSync(simulationPath)) {
    return { payload: readJson(simulationPath), source: simulationPath, computed: false };
  }
  const harness = require('./autonomy_simulation_harness');
  const payload = harness.computeSimulation(dateStr, days);
  return { payload, source: simulationPath, computed: true };
}

function normalizeCandidateRow(row) {
  const r = row && typeof row === 'object' ? row : {};
  return {
    candidate_id: String(r.candidate_id || '').trim() || null,
    category: String(r.category || '').trim().toLowerCase() || 'unknown',
    reason: String(r.reason || '').trim().toLowerCase() || 'unknown',
    support_count: Math.max(0, Math.floor(num(r.support_count, 0))),
    confidence: clamp(num(r.confidence, 0), 0, 1),
    policy_family: String(r.policy_family || '').trim() || null,
    suggestion: String(r.suggestion || '').trim() || null,
    guardrail: String(r.guardrail || '').trim() || null
  };
}

function projectedCounters(effective, candidate) {
  const out = {
    attempts: Math.max(1, Math.floor(num(effective.attempts, 1))),
    executed: Math.max(1, Math.floor(num(effective.executed, 1))),
    shipped: Math.max(0, Math.floor(num(effective.shipped, 0))),
    no_progress: Math.max(0, Math.floor(num(effective.no_progress, 0))),
    safety_stops: Math.max(0, Math.floor(num(effective.safety_stops, 0))),
    policy_holds: Math.max(0, Math.floor(num(effective.policy_holds, 0))),
    budget_holds: Math.max(0, Math.floor(num(effective.budget_holds, 0)))
  };
  const support = Math.max(0, Math.floor(num(candidate.support_count, 0)));
  if (support <= 0) return out;

  const c = String(candidate.category || '').toLowerCase();
  const supportImpact = Math.max(1, Math.floor(support * 0.6));

  if (c === 'no_progress') {
    out.no_progress = Math.max(0, out.no_progress - supportImpact);
    out.attempts = Math.max(1, out.attempts - Math.floor(support * 0.25));
    out.executed = Math.max(out.shipped, out.executed - Math.floor(support * 0.2));
  } else if (c === 'safety_stop') {
    out.safety_stops = Math.max(0, out.safety_stops - supportImpact);
    out.no_progress = Math.max(0, out.no_progress - Math.floor(support * 0.35));
    out.attempts = Math.max(1, out.attempts - Math.floor(support * 0.2));
  } else if (c === 'budget_hold') {
    out.budget_holds = Math.max(0, out.budget_holds - supportImpact);
    out.attempts = Math.max(1, out.attempts - Math.floor(support * 0.15));
  } else if (c === 'policy_hold') {
    out.policy_holds = Math.max(0, out.policy_holds - supportImpact);
    out.no_progress = Math.max(0, out.no_progress - Math.floor(support * 0.1));
    out.attempts = Math.max(1, out.attempts - Math.floor(support * 0.1));
  } else {
    out.no_progress = Math.max(0, out.no_progress - Math.floor(support * 0.2));
  }

  out.executed = Math.max(out.shipped, out.executed);
  return out;
}

function ratesFromCounters(counters) {
  const attempts = Math.max(1, num(counters.attempts, 1));
  const executed = Math.max(1, num(counters.executed, 1));
  const shipped = Math.max(0, num(counters.shipped, 0));
  const noProgress = Math.max(0, num(counters.no_progress, 0));
  const safetyStops = Math.max(0, num(counters.safety_stops, 0));
  return {
    drift_rate: noProgress / attempts,
    yield_rate: shipped / executed,
    safety_stop_rate: safetyStops / attempts
  };
}

function evaluateCandidate(candidate, context) {
  const projected = projectedCounters(context.current_effective_counters, candidate);
  const projectedRates = ratesFromCounters(projected);
  const baselineRates = context.baseline_effective_rates;
  const tol = context.thresholds;

  const driftDelta = projectedRates.drift_rate - baselineRates.drift_rate;
  const yieldDelta = projectedRates.yield_rate - baselineRates.yield_rate;
  const safetyDelta = projectedRates.safety_stop_rate - baselineRates.safety_stop_rate;

  const passDrift = driftDelta <= tol.max_drift_rate_increase;
  const passYield = yieldDelta >= -tol.max_yield_rate_drop;
  const passSafety = safetyDelta <= tol.max_safety_stop_rate_increase;
  const passConfidence = candidate.confidence >= context.min_confidence;
  const pass = passDrift && passYield && passSafety && passConfidence;

  const failures = [];
  if (!passConfidence) failures.push('candidate_confidence_below_floor');
  if (!passDrift) failures.push('projected_effective_drift_regression');
  if (!passYield) failures.push('projected_effective_yield_regression');
  if (!passSafety) failures.push('projected_effective_safety_regression');

  return {
    ...candidate,
    replay_pass: pass,
    failures,
    projected_effective_rates: {
      drift_rate: Number(projectedRates.drift_rate.toFixed(6)),
      yield_rate: Number(projectedRates.yield_rate.toFixed(6)),
      safety_stop_rate: Number(projectedRates.safety_stop_rate.toFixed(6))
    },
    projected_effective_counters: projected,
    deltas_vs_baseline: {
      drift_rate: Number(driftDelta.toFixed(6)),
      yield_rate: Number(yieldDelta.toFixed(6)),
      safety_stop_rate: Number(safetyDelta.toFixed(6))
    }
  };
}

function buildReplay(dateStr, opts = {}) {
  const days = toInt(opts.days, 180, 1, 365);
  const simulationPath = resolvePath(opts.simulation, defaultSimulationPath(dateStr));
  const baselinePath = resolvePath(opts.baseline, BASELINE_PATH);
  const candidatesPath = resolvePath(opts.candidates, latestCandidatePath() || '');
  const minConfidence = clamp(num(opts.min_confidence, 0.65), 0, 1);

  if (!fs.existsSync(baselinePath)) throw new Error(`baseline_missing:${baselinePath}`);
  if (!candidatesPath || !fs.existsSync(candidatesPath)) throw new Error(`candidates_missing:${candidatesPath || CANDIDATES_DIR}`);

  const baseline = readJson(baselinePath);
  const simulationLoad = loadSimulation(dateStr, days, simulationPath);
  const simulation = simulationLoad.payload;
  const candidatesDoc = readJson(candidatesPath);

  const baselineEffective = baseline
    && baseline.baseline
    && baseline.baseline.effective
    && typeof baseline.baseline.effective === 'object'
      ? baseline.baseline.effective
      : {};
  const thresholds = baseline
    && baseline.gate_policy
    && baseline.gate_policy.effective
    && typeof baseline.gate_policy.effective === 'object'
      ? baseline.gate_policy.effective
      : {};
  const currentEffective = simulation
    && simulation.effective_counters
    && typeof simulation.effective_counters === 'object'
      ? simulation.effective_counters
      : {};

  const candidateRowsRaw = Array.isArray(candidatesDoc && candidatesDoc.candidates) ? candidatesDoc.candidates : [];
  const candidateRows = candidateRowsRaw.map(normalizeCandidateRow);

  const context = {
    baseline_effective_rates: {
      drift_rate: num(baselineEffective.drift_rate, 0),
      yield_rate: num(baselineEffective.yield_rate, 0),
      safety_stop_rate: num(baselineEffective.safety_stop_rate, 0)
    },
    thresholds: {
      max_drift_rate_increase: num(thresholds.max_drift_rate_increase, 0.003),
      max_yield_rate_drop: num(thresholds.max_yield_rate_drop, 0.03),
      max_safety_stop_rate_increase: num(thresholds.max_safety_stop_rate_increase, 0)
    },
    current_effective_counters: {
      attempts: num(currentEffective.attempts, 1),
      executed: num(currentEffective.executed, 1),
      shipped: num(currentEffective.shipped, 0),
      no_progress: num(currentEffective.no_progress, 0),
      safety_stops: num(currentEffective.safety_stops, 0),
      policy_holds: num(currentEffective.policy_holds, 0),
      budget_holds: num(currentEffective.budget_holds, 0)
    },
    min_confidence: minConfidence
  };

  const evaluated = candidateRows.map((row) => evaluateCandidate(row, context));
  const replayPass = evaluated.filter((row) => row.replay_pass === true);
  const replayFail = evaluated.filter((row) => row.replay_pass !== true);

  replayPass.sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    if (b.support_count !== a.support_count) return b.support_count - a.support_count;
    return String(a.candidate_id || '').localeCompare(String(b.candidate_id || ''));
  });

  return {
    ok: true,
    type: 'autonomy_non_yield_replay',
    ts: new Date().toISOString(),
    end_date: dateStr,
    days,
    sources: {
      baseline_path: baselinePath,
      candidates_path: candidatesPath,
      simulation_path: simulationLoad.source,
      simulation_computed: simulationLoad.computed === true
    },
    gate_policy: {
      min_confidence: minConfidence,
      effective: context.thresholds
    },
    baseline_effective_rates: context.baseline_effective_rates,
    current_effective_counters: context.current_effective_counters,
    summary: {
      candidates_total: evaluated.length,
      replay_pass: replayPass.length,
      replay_fail: replayFail.length
    },
    replay_pass_candidates: replayPass,
    replay_fail_candidates: replayFail.slice(0, 50)
  };
}

function writeOutput(payload) {
  ensureDir(REPORT_DIR);
  const fp = path.join(REPORT_DIR, `${payload.end_date}.json`);
  fs.writeFileSync(fp, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  return fp;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || 'run').trim().toLowerCase();
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    usage();
    return;
  }
  const dateStr = resolveDate(args);
  const payload = buildReplay(dateStr, {
    days: args.days,
    candidates: args.candidates,
    baseline: args.baseline,
    simulation: args.simulation,
    min_confidence: args['min-confidence'] != null ? args['min-confidence'] : args.min_confidence
  });
  const write = cmd === 'run' && String(args.write == null ? '1' : args.write).trim() !== '0';
  if (write) payload.report_path = writeOutput(payload);
  process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stdout.write(JSON.stringify({ ok: false, error: String(err && err.message || err || 'non_yield_replay_failed') }) + '\n');
    process.exit(1);
  }
}
