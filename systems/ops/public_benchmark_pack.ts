#!/usr/bin/env node
'use strict';
export {};

/**
 * public_benchmark_pack.js
 *
 * Generates a reproducible benchmark artifact for external sharing:
 * - simulation drift/yield/safety snapshot
 * - red-team harness survival snapshot
 * - emergence/workflow telemetry snapshot
 *
 * Usage:
 *   node systems/ops/public_benchmark_pack.js run [YYYY-MM-DD] [--days=N]
 *   node systems/ops/public_benchmark_pack.js status [YYYY-MM-DD|latest]
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT_DIR = process.env.PUBLIC_BENCHMARK_OUT_DIR
  ? path.resolve(process.env.PUBLIC_BENCHMARK_OUT_DIR)
  : path.join(ROOT, 'state', 'ops', 'public_benchmarks');
const LATEST_PATH = path.join(OUT_DIR, 'latest.json');
const HISTORY_PATH = path.join(OUT_DIR, 'history.jsonl');
const DOC_PATH = path.join(ROOT, 'docs', 'PUBLIC_BENCHMARKS.md');

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/public_benchmark_pack.js run [YYYY-MM-DD] [--days=N]');
  console.log('  node systems/ops/public_benchmark_pack.js status [YYYY-MM-DD|latest]');
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

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
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

function parseJsonFromStdout(stdout) {
  const raw = String(stdout || '').trim();
  try { return JSON.parse(raw); } catch {}
  const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function runJson(args, extraEnv = {}) {
  const run = spawnSync('node', args, {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv }
  });
  const payload = parseJsonFromStdout(run.stdout);
  return {
    ok: run.status === 0,
    status: run.status == null ? 1 : run.status,
    payload,
    stdout: String(run.stdout || '').trim(),
    stderr: String(run.stderr || '').trim()
  };
}

function relPath(filePath) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function benchmarkVerdict(snapshot) {
  const simVerdict = String(snapshot && snapshot.simulation && snapshot.simulation.verdict || 'warn');
  const redCritical = Number(snapshot && snapshot.red_team && snapshot.red_team.critical_fail_cases || 0);
  if (simVerdict === 'fail' || redCritical > 0) return 'warn';
  if (simVerdict === 'warn') return 'warn';
  return 'pass';
}

function renderDoc(snapshot) {
  const drift = snapshot && snapshot.simulation ? snapshot.simulation.drift_rate : null;
  const yieldRate = snapshot && snapshot.simulation ? snapshot.simulation.yield_rate : null;
  const safety = snapshot && snapshot.simulation ? snapshot.simulation.safety_stop_rate : null;
  const redFail = snapshot && snapshot.red_team ? snapshot.red_team.fail_cases : null;
  const redCritical = snapshot && snapshot.red_team ? snapshot.red_team.critical_fail_cases : null;
  const workflowActive = snapshot && snapshot.workflow ? snapshot.workflow.active : null;
  const observerMood = snapshot && snapshot.observer ? snapshot.observer.mood : null;

  return [
    '# Public Benchmarks',
    '',
    `Updated: ${snapshot.ts}`,
    `Date: ${snapshot.date}`,
    `Verdict: ${snapshot.verdict}`,
    '',
    '| Metric | Value |',
    '|---|---|',
    `| Drift rate | ${drift == null ? 'n/a' : Number(drift).toFixed(3)} |`,
    `| Yield rate | ${yieldRate == null ? 'n/a' : Number(yieldRate).toFixed(3)} |`,
    `| Safety stop rate | ${safety == null ? 'n/a' : Number(safety).toFixed(3)} |`,
    `| Red-team fail cases | ${redFail == null ? 'n/a' : Number(redFail)} |`,
    `| Red-team critical fail cases | ${redCritical == null ? 'n/a' : Number(redCritical)} |`,
    `| Active workflows | ${workflowActive == null ? 'n/a' : Number(workflowActive)} |`,
    `| Observer mood | ${observerMood || 'n/a'} |`,
    '',
    'This artifact is generated by `systems/ops/public_benchmark_pack.js`.',
    ''
  ].join('\n');
}

function runCmd(dateStr, args) {
  const days = clampInt(args.days, 1, 365, 180);

  const simulationRun = runJson([
    'systems/autonomy/autonomy_simulation_harness.js',
    'run',
    dateStr,
    `--days=${days}`,
    '--write=1'
  ]);
  const redTeamRun = runJson([
    'systems/autonomy/red_team_harness.js',
    'run',
    dateStr,
    '--max-cases=4'
  ], {
    RED_TEAM_DISABLE_MODEL_EXEC: process.env.RED_TEAM_DISABLE_MODEL_EXEC || '1'
  });
  const observerStatus = runJson([
    'systems/autonomy/observer_mirror.js',
    'status',
    dateStr
  ]);
  const workflowStatus = runJson([
    'systems/workflow/workflow_controller.js',
    'status'
  ]);

  const simPayload = simulationRun.payload && typeof simulationRun.payload === 'object' ? simulationRun.payload : {};
  const checks = simPayload.checks_effective && typeof simPayload.checks_effective === 'object'
    ? simPayload.checks_effective
    : (simPayload.checks && typeof simPayload.checks === 'object' ? simPayload.checks : {});
  const redPayload = redTeamRun.payload && typeof redTeamRun.payload === 'object' ? redTeamRun.payload : {};
  const redSummary = redPayload.summary && typeof redPayload.summary === 'object' ? redPayload.summary : {};
  const observerPayload = observerStatus.payload && typeof observerStatus.payload === 'object' ? observerStatus.payload : {};
  const workflowPayload = workflowStatus.payload && typeof workflowStatus.payload === 'object' ? workflowStatus.payload : {};

  const snapshot = {
    ok: true,
    type: 'public_benchmark_pack',
    ts: nowIso(),
    date: dateStr,
    window_days: days,
    simulation: {
      verdict: String(simPayload.verdict || 'unknown'),
      drift_rate: checks.drift_rate ? Number(checks.drift_rate.value || 0) : null,
      yield_rate: checks.yield_rate ? Number(checks.yield_rate.value || 0) : null,
      safety_stop_rate: checks.safety_stop_rate ? Number(checks.safety_stop_rate.value || 0) : null,
      attempts: Number(simPayload.attempts || 0)
    },
    red_team: {
      ok: redTeamRun.ok && redPayload.ok === true,
      selected_cases: Number(redSummary.selected_cases || 0),
      executed_cases: Number(redSummary.executed_cases || 0),
      fail_cases: Number(redSummary.fail_cases || 0),
      critical_fail_cases: Number(redSummary.critical_fail_cases || 0)
    },
    observer: {
      mood: observerPayload.mood || null,
      recommendation: observerPayload.recommendation || null
    },
    workflow: {
      total: Number(workflowPayload.total || 0),
      active: workflowPayload.counts ? Number(workflowPayload.counts.active || 0) : 0
    },
    sources: {
      simulation_ok: simulationRun.ok,
      red_team_ok: redTeamRun.ok,
      observer_ok: observerStatus.ok,
      workflow_ok: workflowStatus.ok
    }
  };
  snapshot.verdict = benchmarkVerdict(snapshot);

  ensureDir(OUT_DIR);
  const outPath = path.join(OUT_DIR, `${dateStr}.json`);
  writeJsonAtomic(outPath, snapshot);
  writeJsonAtomic(LATEST_PATH, snapshot);
  appendJsonl(HISTORY_PATH, {
    ts: snapshot.ts,
    type: snapshot.type,
    date: snapshot.date,
    verdict: snapshot.verdict,
    drift_rate: snapshot.simulation.drift_rate,
    yield_rate: snapshot.simulation.yield_rate,
    red_team_critical_fail_cases: snapshot.red_team.critical_fail_cases
  });

  fs.writeFileSync(DOC_PATH, renderDoc(snapshot), 'utf8');

  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: snapshot.type,
    date: snapshot.date,
    verdict: snapshot.verdict,
    drift_rate: snapshot.simulation.drift_rate,
    yield_rate: snapshot.simulation.yield_rate,
    red_team_critical_fail_cases: snapshot.red_team.critical_fail_cases,
    output_path: relPath(outPath),
    doc_path: relPath(DOC_PATH)
  })}\n`);
}

function statusCmd(dateArg) {
  const useLatest = String(dateArg || '').trim().toLowerCase() === 'latest';
  const fp = useLatest ? LATEST_PATH : path.join(OUT_DIR, `${dateArgOrToday(dateArg)}.json`);
  const payload = readJson(fp, null);
  if (!payload || typeof payload !== 'object') {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      type: 'public_benchmark_pack_status',
      error: 'benchmark_snapshot_missing'
    })}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'public_benchmark_pack_status',
    date: payload.date || null,
    ts: payload.ts || null,
    verdict: payload.verdict || null,
    drift_rate: payload.simulation ? payload.simulation.drift_rate : null,
    yield_rate: payload.simulation ? payload.simulation.yield_rate : null,
    red_team_critical_fail_cases: payload.red_team ? payload.red_team.critical_fail_cases : null
  })}\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim().toLowerCase();
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    usage();
    return;
  }
  if (cmd === 'run') return runCmd(dateArgOrToday(args._[1]), args);
  if (cmd === 'status') return statusCmd(args._[1] || 'latest');
  usage();
  process.exitCode = 2;
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      type: 'public_benchmark_pack',
      error: String(err && err.message ? err.message : err || 'public_benchmark_pack_failed')
    })}\n`);
    process.exit(1);
  }
}
