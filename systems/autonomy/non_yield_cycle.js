#!/usr/bin/env node
'use strict';

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..', '..');
const AUTONOMY_DIR = process.env.AUTONOMY_STATE_DIR
  ? path.resolve(process.env.AUTONOMY_STATE_DIR)
  : path.join(ROOT, 'state', 'autonomy');
const CYCLE_REPORT_DIR = path.join(AUTONOMY_DIR, 'autophagy_cycle');

function usage() {
  console.log('Usage:');
  console.log('  node systems/autonomy/non_yield_cycle.js run [YYYY-MM-DD] [--days=N] [--queue=1|0] [--write=1|0]');
  console.log('  node systems/autonomy/non_yield_cycle.js status [YYYY-MM-DD] [--days=N] [--queue=1|0]');
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

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
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

  const simulationCmd = ['systems/autonomy/autonomy_simulation_harness.js', 'run', dateStr, `--days=${days}`, `--write=${write ? 1 : 0}`];
  const simulation = runJson(simulationCmd);
  if (!simulation.ok) return { ok: false, stage: 'simulation', error: simulation };

  const baselineCheck = runJson([
    'systems/autonomy/autophagy_baseline_guard.js',
    'check',
    `--from=state/autonomy/simulations/${dateStr}.json`,
    '--baseline=state/autonomy/autophagy_baseline.json',
    '--strict'
  ]);
  if (!baselineCheck.ok) return { ok: false, stage: 'baseline_check', error: baselineCheck };

  const harvest = runJson([
    'systems/autonomy/non_yield_harvest.js',
    'run',
    dateStr,
    '--lookback-days=30',
    '--quarantine-days=7',
    '--min-support=5',
    '--min-confidence=0.65',
    `--write=${write ? 1 : 0}`
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
    '--baseline=state/autonomy/autophagy_baseline.json',
    `--simulation=state/autonomy/simulations/${dateStr}.json`,
    `--write=${write ? 1 : 0}`
  ];
  if (harvestPath) replayArgs.push(`--candidates=${harvestPath}`);
  const replay = runJson(replayArgs);
  if (!replay.ok) return { ok: false, stage: 'replay', error: replay };

  const replayPath = replay.payload && replay.payload.report_path
    ? String(replay.payload.report_path)
    : `state/autonomy/autophagy_replay/${dateStr}.json`;
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
    stages: {
      simulation: {
        verdict: simulation.payload && simulation.payload.verdict,
        verdict_effective: simulation.payload && simulation.payload.verdict_effective,
        checks_effective: simulation.payload && simulation.payload.checks_effective || null
      },
      baseline_check: {
        ok: baselineCheck.payload && baselineCheck.payload.ok === true,
        failures: baselineCheck.payload && baselineCheck.payload.failures || []
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
  const out = runCycle({
    date: dateStr,
    days: args.days,
    queue_enabled: String(args.queue == null ? (cmd === 'run' ? '1' : '0') : args.queue).trim() !== '0',
    write: String(args.write == null ? '1' : args.write).trim() !== '0'
  });
  if (!out.ok) {
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    process.exit(1);
  }
  if (cmd === 'run' && String(args.write == null ? '1' : args.write).trim() !== '0') {
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
