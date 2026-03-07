#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_BASELINE_PATH = path.join(ROOT, 'state', 'autonomy', 'autophagy_baseline.json');
const DEFAULT_SIM_DIR = path.join(ROOT, 'state', 'autonomy', 'simulations');

function usage() {
  console.log('Usage:');
  console.log('  node systems/autonomy/autophagy_baseline_guard.js capture [--from=<simulation.json>] [--out=<baseline.json>]');
  console.log('  node systems/autonomy/autophagy_baseline_guard.js check [--from=<simulation.json>] [--baseline=<baseline.json>] [--strict]');
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

function resolvePath(raw, fallbackAbs) {
  const v = String(raw || '').trim();
  if (!v) return fallbackAbs;
  return path.isAbsolute(v) ? v : path.join(ROOT, v);
}

function ensureDirForFile(fp) {
  const dir = path.dirname(fp);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readJson(fp) {
  return JSON.parse(fs.readFileSync(fp, 'utf8'));
}

function lastSimulationPath() {
  if (!fs.existsSync(DEFAULT_SIM_DIR)) {
    throw new Error(`simulation_dir_missing:${DEFAULT_SIM_DIR}`);
  }
  const files = fs.readdirSync(DEFAULT_SIM_DIR)
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name))
    .sort();
  if (!files.length) {
    throw new Error(`simulation_reports_missing:${DEFAULT_SIM_DIR}`);
  }
  return path.join(DEFAULT_SIM_DIR, files[files.length - 1]);
}

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function pickMetricSection(payload, section) {
  const src = payload && payload[section] && typeof payload[section] === 'object'
    ? payload[section]
    : {};
  return {
    drift_rate: num(src.drift_rate && src.drift_rate.value),
    yield_rate: num(src.yield_rate && src.yield_rate.value),
    safety_stop_rate: num(src.safety_stop_rate && src.safety_stop_rate.value),
    policy_hold_rate: num(src.policy_hold_rate && src.policy_hold_rate.value),
    budget_hold_rate: num(src.budget_hold_rate && src.budget_hold_rate.value)
  };
}

function buildBaselineFromSimulation(payload, sourcePath) {
  if (!payload || payload.ok !== true || String(payload.type || '') !== 'autonomy_simulation_harness') {
    throw new Error('invalid_simulation_payload');
  }
  return {
    ok: true,
    schema: 'autophagy_baseline_lock.v1',
    created_at: new Date().toISOString(),
    source: {
      report_path: sourcePath,
      end_date: String(payload.end_date || ''),
      days: num(payload.days, 0),
      ts: String(payload.ts || '')
    },
    gate_policy: {
      description: 'Hard non-regression gate for autophagy rollout stages against effective metrics.',
      effective: {
        max_drift_rate_increase: 0.003,
        max_yield_rate_drop: 0.03,
        max_safety_stop_rate_increase: 0
      }
    },
    baseline: {
      effective: pickMetricSection(payload, 'checks_effective'),
      raw: pickMetricSection(payload, 'checks'),
      verdict_effective: String(payload.verdict_effective || ''),
      verdict_raw: String(payload.verdict_raw || ''),
      counters_effective: payload && payload.effective_counters && typeof payload.effective_counters === 'object'
        ? payload.effective_counters
        : {},
      counters_raw: payload && payload.counters && typeof payload.counters === 'object'
        ? payload.counters
        : {}
    }
  };
}

function evalGate(baseline, current) {
  const tol = baseline && baseline.gate_policy && baseline.gate_policy.effective
    ? baseline.gate_policy.effective
    : {};
  const base = baseline && baseline.baseline && baseline.baseline.effective
    ? baseline.baseline.effective
    : {};
  const now = pickMetricSection(current, 'checks_effective');

  const driftDelta = num(now.drift_rate) - num(base.drift_rate);
  const yieldDelta = num(now.yield_rate) - num(base.yield_rate);
  const safetyDelta = num(now.safety_stop_rate) - num(base.safety_stop_rate);

  const driftPass = driftDelta <= num(tol.max_drift_rate_increase, 0);
  const yieldPass = yieldDelta >= -num(tol.max_yield_rate_drop, 0);
  const safetyPass = safetyDelta <= num(tol.max_safety_stop_rate_increase, 0);

  const failures = [];
  if (!driftPass) failures.push('effective_drift_regressed');
  if (!yieldPass) failures.push('effective_yield_regressed');
  if (!safetyPass) failures.push('effective_safety_regressed');

  return {
    ok: failures.length === 0,
    type: 'autophagy_baseline_guard',
    ts: new Date().toISOString(),
    baseline_source: baseline && baseline.source ? baseline.source : null,
    current_source: {
      end_date: String(current && current.end_date || ''),
      days: num(current && current.days, 0),
      ts: String(current && current.ts || '')
    },
    baseline_effective: {
      drift_rate: num(base.drift_rate),
      yield_rate: num(base.yield_rate),
      safety_stop_rate: num(base.safety_stop_rate)
    },
    current_effective: {
      drift_rate: num(now.drift_rate),
      yield_rate: num(now.yield_rate),
      safety_stop_rate: num(now.safety_stop_rate)
    },
    deltas: {
      drift_rate: Number(driftDelta.toFixed(6)),
      yield_rate: Number(yieldDelta.toFixed(6)),
      safety_stop_rate: Number(safetyDelta.toFixed(6))
    },
    thresholds: {
      max_drift_rate_increase: num(tol.max_drift_rate_increase, 0),
      max_yield_rate_drop: num(tol.max_yield_rate_drop, 0),
      max_safety_stop_rate_increase: num(tol.max_safety_stop_rate_increase, 0)
    },
    failures,
    notes: [
      'Gate compares effective metrics only.',
      'Simulation verdict can still fail for budget_autopause_active independently of this gate.'
    ]
  };
}

function cmdCapture(args) {
  const sourcePath = resolvePath(args.from, lastSimulationPath());
  const outPath = resolvePath(args.out, DEFAULT_BASELINE_PATH);
  const payload = readJson(sourcePath);
  const baseline = buildBaselineFromSimulation(payload, sourcePath);
  ensureDirForFile(outPath);
  fs.writeFileSync(outPath, JSON.stringify(baseline, null, 2) + '\n', 'utf8');
  process.stdout.write(JSON.stringify({ ok: true, baseline_path: outPath, source_path: sourcePath, schema: baseline.schema }) + '\n');
}

function cmdCheck(args) {
  const baselinePath = resolvePath(args.baseline, DEFAULT_BASELINE_PATH);
  const sourcePath = resolvePath(args.from, lastSimulationPath());
  const strict = args.strict === true;
  const baseline = readJson(baselinePath);
  const current = readJson(sourcePath);
  const out = evalGate(baseline, current);
  out.baseline_path = baselinePath;
  out.simulation_path = sourcePath;
  out.strict = strict;
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  if (strict && out.ok !== true) process.exit(2);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim().toLowerCase();
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || args.help === true) {
    usage();
    return;
  }
  if (cmd === 'capture') {
    cmdCapture(args);
    return;
  }
  if (cmd === 'check') {
    cmdCheck(args);
    return;
  }
  usage();
  process.exit(2);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stdout.write(JSON.stringify({ ok: false, error: String(err && err.message || err || 'autophagy_baseline_guard_failed') }) + '\n');
    process.exit(1);
  }
}
