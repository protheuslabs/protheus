#!/usr/bin/env node
'use strict';

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_AUTONOMY_DIR = fs.existsSync(path.join(ROOT, 'local', 'state', 'autonomy'))
  ? path.join(ROOT, 'local', 'state', 'autonomy')
  : path.join(ROOT, 'state', 'autonomy');
const AUTONOMY_DIR = process.env.AUTONOMY_STATE_DIR
  ? path.resolve(process.env.AUTONOMY_STATE_DIR)
  : DEFAULT_AUTONOMY_DIR;
const CYCLE_REPORT_DIR = path.join(AUTONOMY_DIR, 'autophagy_cycle');
const TRIAL_PATH = path.join(AUTONOMY_DIR, 'autophagy_trial.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/autonomy/non_yield_cycle.js run [YYYY-MM-DD] [--days=N] [--queue=1|0] [--write=1|0] [--strict-baseline=1|0]');
  console.log('  node systems/autonomy/non_yield_cycle.js status [YYYY-MM-DD] [--days=N] [--queue=1|0] [--strict-baseline=1|0]');
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

function toInt(v, fallback, lo = 1, hi = 365) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

function toBool(v, fallback = false) {
  if (v == null) return fallback;
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  return fallback;
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function toRepoRelative(fp) {
  return path.relative(ROOT, fp).replace(/\\/g, '/');
}

function parseDateMs(dateStr) {
  const d = new Date(`${String(dateStr || '').trim()}T00:00:00.000Z`);
  return Number.isFinite(d.getTime()) ? d.getTime() : null;
}

function dayDiff(fromDate, toDate) {
  const fromMs = parseDateMs(fromDate);
  const toMs = parseDateMs(toDate);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return null;
  return Math.floor((toMs - fromMs) / 86400000);
}

function loadTrialConfig() {
  if (!fs.existsSync(TRIAL_PATH)) return null;
  try {
    const obj = JSON.parse(fs.readFileSync(TRIAL_PATH, 'utf8'));
    return obj && typeof obj === 'object' ? obj : null;
  } catch {
    return null;
  }
}

function trialSnapshotForDate(dateStr) {
  const trial = loadTrialConfig();
  if (!trial) return null;
  const startDate = String(trial.start_date || '').trim();
  const endDate = String(trial.end_date || '').trim();
  const weeks = Math.max(1, Number(trial.duration_weeks || 8));
  const status = String(trial.status || '').trim().toLowerCase() || 'active';
  const elapsed = dayDiff(startDate, dateStr);
  const remaining = dayDiff(dateStr, endDate);
  const totalDays = Math.max(1, Math.round(weeks * 7));
  const inWindow = elapsed != null && remaining != null && elapsed >= 0 && remaining >= 0;
  const weekIndex = elapsed == null ? null : Math.max(1, Math.min(weeks, Math.floor(elapsed / 7) + 1));
  const checkpoints = Array.isArray(trial.checkpoints_weeks)
    ? trial.checkpoints_weeks.map((v) => Number(v)).filter((v) => Number.isFinite(v) && v >= 1 && v <= weeks)
    : [2, 4, 6, 8].filter((v) => v <= weeks);
  const dueCheckpoint = weekIndex != null && checkpoints.includes(weekIndex)
    ? weekIndex
    : null;

  return {
    id: trial.id || null,
    name: trial.name || null,
    status: status === 'active' && inWindow ? 'active' : status,
    start_date: startDate || null,
    end_date: endDate || null,
    duration_weeks: weeks,
    total_days: totalDays,
    day_index: elapsed == null ? null : Math.max(0, elapsed + 1),
    days_elapsed: elapsed == null ? null : Math.max(0, elapsed),
    days_remaining: remaining == null ? null : Math.max(0, remaining),
    week_index: weekIndex,
    in_window: inWindow,
    checkpoint_weeks: checkpoints,
    checkpoint_due_week: dueCheckpoint,
    success_criteria: trial.success_criteria && typeof trial.success_criteria === 'object'
      ? trial.success_criteria
      : null
  };
}

function runJson(args, env = {}) {
  const res = spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120000,
    env: { ...process.env, ...env }
  });
  if (res.error) {
    return { ok: false, error: String(res.error) };
  }
  const stdout = String(res.stdout || '').trim();
  const stderr = String(res.stderr || '').trim();
  if (res.status !== 0) {
    return { ok: false, status: res.status, stdout, stderr, error: 'command_failed' };
  }
  try {
    const out = JSON.parse(stdout);
    return { ok: true, payload: out, stdout, stderr };
  } catch {
    const start = stdout.indexOf('{');
    const end = stdout.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        const out = JSON.parse(stdout.slice(start, end + 1));
        return { ok: true, payload: out, stdout, stderr };
      } catch {
        return { ok: false, stdout, stderr, error: 'json_parse_failed' };
      }
    }
    return { ok: false, stdout, stderr, error: 'json_parse_failed' };
  }
}

function runCycle(opts = {}) {
  const dateStr = String(opts.date || todayStr());
  const days = toInt(opts.days, 180, 1, 365);
  const queueEnabled = opts.queue_enabled === true;
  const write = opts.write !== false;
  const baselineStrict = opts.baseline_strict === true;
  const artifactWrite = write === true;
  const trial = trialSnapshotForDate(dateStr);
  const simRel = toRepoRelative(path.join(AUTONOMY_DIR, 'simulations', `${dateStr}.json`));
  const baselineRel = toRepoRelative(path.join(AUTONOMY_DIR, 'autophagy_baseline.json'));
  const replayRel = toRepoRelative(path.join(AUTONOMY_DIR, 'autophagy_replay', `${dateStr}.json`));

  const simulationCmd = ['systems/autonomy/autonomy_simulation_harness.js', 'run', dateStr, `--days=${days}`, `--write=${artifactWrite ? 1 : 0}`];
  const simulation = runJson(simulationCmd);
  if (!simulation.ok) return { ok: false, stage: 'simulation', error: simulation };

  const baselineArgs = [
    'systems/autonomy/autophagy_baseline_guard.js',
    'check',
    `--from=${simRel}`,
    `--baseline=${baselineRel}`
  ];
  if (baselineStrict) baselineArgs.push('--strict');
  const baselineCheck = runJson(baselineArgs);
  if (!baselineCheck.ok) return { ok: false, stage: 'baseline_check', error: baselineCheck };

  const backfill = runJson([
    'systems/autonomy/non_yield_ledger_backfill.js',
    artifactWrite ? 'run' : 'status',
    dateStr,
    `--days=${days}`,
    `--write=${artifactWrite ? 1 : 0}`
  ]);
  if (!backfill.ok) return { ok: false, stage: 'backfill', error: backfill };

  const harvest = runJson([
    'systems/autonomy/non_yield_harvest.js',
    'run',
    dateStr,
    '--lookback-days=30',
    '--quarantine-days=7',
    '--min-support=5',
    '--min-confidence=0.65',
    `--write=${artifactWrite ? 1 : 0}`
  ]);
  if (!harvest.ok) return { ok: false, stage: 'harvest', error: harvest };

  const harvestPath = harvest.payload && harvest.payload.report_path
    ? String(harvest.payload.report_path)
    : null;
  const replayArgs = [
    'systems/autonomy/non_yield_replay.js',
    'run',
    dateStr,
    `--days=${days}`,
    `--baseline=${baselineRel}`,
    `--simulation=${simRel}`,
    `--write=${artifactWrite ? 1 : 0}`
  ];
  if (harvestPath) replayArgs.push(`--candidates=${harvestPath}`);
  const replay = runJson(replayArgs);
  if (!replay.ok) return { ok: false, stage: 'replay', error: replay };

  const replayPath = replay.payload && replay.payload.report_path
    ? String(replay.payload.report_path)
    : replayRel;
  const enqueue = runJson([
    'systems/autonomy/non_yield_enqueue.js',
    queueEnabled ? 'run' : 'status',
    `--replay=${replayPath}`,
    '--max=10'
  ]);
  if (!enqueue.ok) return { ok: false, stage: 'enqueue', error: enqueue };

  return {
    ok: true,
    type: 'autonomy_non_yield_cycle',
    ts: new Date().toISOString(),
    end_date: dateStr,
    days,
    queue_enabled: queueEnabled,
    trial,
    stages: {
      simulation: {
        verdict: simulation.payload && simulation.payload.verdict,
        verdict_effective: simulation.payload && simulation.payload.verdict_effective,
        checks_effective: simulation.payload && simulation.payload.checks_effective || null
      },
      baseline_check: {
        ok: baselineCheck.payload && baselineCheck.payload.ok === true,
        strict: baselineStrict,
        failures: baselineCheck.payload && baselineCheck.payload.failures || []
      },
      backfill: {
        inserted_rows: backfill.payload && backfill.payload.counts ? Number(backfill.payload.counts.inserted_rows || 0) : 0,
        scanned_runs: backfill.payload && backfill.payload.counts ? Number(backfill.payload.counts.scanned_runs || 0) : 0,
        classified_runs: backfill.payload && backfill.payload.counts ? Number(backfill.payload.counts.classified_runs || 0) : 0,
        inserted_by_category: backfill.payload && backfill.payload.inserted_by_category && typeof backfill.payload.inserted_by_category === 'object'
          ? backfill.payload.inserted_by_category
          : {}
      },
      harvest: {
        candidates: harvest.payload && harvest.payload.counts ? Number(harvest.payload.counts.candidates || 0) : 0,
        report_path: harvest.payload && harvest.payload.report_path || null
      },
      replay: {
        replay_pass: replay.payload && replay.payload.summary ? Number(replay.payload.summary.replay_pass || 0) : 0,
        replay_fail: replay.payload && replay.payload.summary ? Number(replay.payload.summary.replay_fail || 0) : 0,
        report_path: replay.payload && replay.payload.report_path || null
      },
      enqueue: {
        queued: enqueue.payload && enqueue.payload.counts ? Number(enqueue.payload.counts.queued || 0) : 0,
        skipped_existing: enqueue.payload && enqueue.payload.counts ? Number(enqueue.payload.counts.skipped_existing || 0) : 0,
        dry_run: enqueue.payload && enqueue.payload.dry_run === true
      }
    }
  };
}

function writeOutput(payload) {
  ensureDir(CYCLE_REPORT_DIR);
  const fp = path.join(CYCLE_REPORT_DIR, `${payload.end_date}.json`);
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
  const writeEnabled = String(args.write == null ? (cmd === 'run' ? '1' : '0') : args.write).trim() !== '0';
  const out = runCycle({
    date: dateStr,
    days: args.days,
    queue_enabled: String(args.queue == null ? (cmd === 'run' ? '1' : '0') : args.queue).trim() !== '0',
    write: writeEnabled,
    baseline_strict: toBool(
      args['strict-baseline'] != null ? args['strict-baseline'] : process.env.AUTOPHAGY_CYCLE_STRICT_BASELINE,
      false
    )
  });
  if (!out.ok) {
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    process.exit(1);
  }
  if (cmd === 'run' && writeEnabled) {
    out.report_path = writeOutput(out);
  }
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stdout.write(JSON.stringify({ ok: false, error: String(err && err.message || err || 'non_yield_cycle_failed') }) + '\n');
    process.exit(1);
  }
}
