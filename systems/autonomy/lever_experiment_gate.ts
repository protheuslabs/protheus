#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = path.join(ROOT, 'config', 'lever_experiment_policy.json');
const DEFAULT_HARNESS_SCRIPT = path.join(ROOT, 'systems', 'autonomy', 'autonomy_simulation_harness.js');
const DEFAULT_WORK_DIR = path.join(ROOT, 'state', 'autonomy', 'lever_experiments');
const ACTIVE_EXPERIMENT_PATH = path.join(DEFAULT_WORK_DIR, 'active.json');
const HISTORY_PATH = path.join(DEFAULT_WORK_DIR, 'history.jsonl');
const REPORTS_DIR = path.join(DEFAULT_WORK_DIR, 'reports');

function usage() {
  console.log('Usage:');
  console.log('  node systems/autonomy/lever_experiment_gate.js start --lever=<id> [--date=YYYY-MM-DD] [--days=180]');
  console.log('  node systems/autonomy/lever_experiment_gate.js evaluate --lever=<id> [--p1=1] [--p1_ref=<ticket>] [--date=YYYY-MM-DD] [--days=180]');
  console.log('  node systems/autonomy/lever_experiment_gate.js scope');
  console.log('  node systems/autonomy/lever_experiment_gate.js stage-code');
  console.log('  node systems/autonomy/lever_experiment_gate.js abort [--lever=<id>]');
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

function nowIso() {
  return new Date().toISOString();
}

function todayStr() {
  return nowIso().slice(0, 10);
}

function toInt(v, fallback, lo = 1, hi = 3650) {
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

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function shortErr(err, fallback = 'unknown_error') {
  const raw = String(err && err.message ? err.message : (err || fallback));
  return raw.length > 240 ? `${raw.slice(0, 237)}...` : raw;
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function ensureParent(fp) {
  ensureDir(path.dirname(fp));
}

function readJsonSafe(fp, fallback = null) {
  try {
    if (!fs.existsSync(fp)) return fallback;
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(fp, payload) {
  ensureParent(fp);
  fs.writeFileSync(fp, JSON.stringify(payload, null, 2) + '\n', 'utf8');
}

function appendJsonl(fp, row) {
  ensureParent(fp);
  fs.appendFileSync(fp, JSON.stringify(row) + '\n', 'utf8');
}

function hashObj(v) {
  return crypto.createHash('sha256').update(JSON.stringify(v || {})).digest('hex').slice(0, 16);
}

function normalizePath(p) {
  return String(p || '').replace(/\\/g, '/').replace(/^\.?\//, '');
}

function globToRegExp(glob) {
  const g = normalizePath(glob).replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const globStarToken = '__GLOBSTAR__';
  const globToken = '__GLOB__';
  const rx = g
    .replace(/\*\*/g, globStarToken)
    .replace(/\*/g, globToken)
    .replace(new RegExp(globStarToken, 'g'), '.*')
    .replace(new RegExp(globToken, 'g'), '[^/]*');
  return new RegExp(`^${rx}$`);
}

function pathMatchesAny(relPath, patterns) {
  const rel = normalizePath(relPath);
  for (const pattern of patterns || []) {
    const token = normalizePath(pattern);
    if (!token) continue;
    if (!token.includes('*') && rel === token) return true;
    if (token.endsWith('/**')) {
      const prefix = token.slice(0, -3);
      if (rel.startsWith(prefix)) return true;
    }
    if (globToRegExp(token).test(rel)) return true;
  }
  return false;
}

function parseGitStatusPaths(stdout) {
  const out = [];
  const seen = new Set();
  const lines = String(stdout || '').split('\n');
  for (const rawLine of lines) {
    const line = String(rawLine || '');
    if (!line.trim()) continue;
    if (line.length < 4) continue;
    const body = line.slice(3).trim();
    if (!body) continue;
    let rel = body;
    const arrow = body.lastIndexOf(' -> ');
    if (arrow !== -1) rel = body.slice(arrow + 4).trim();
    if (rel.startsWith('"') && rel.endsWith('"')) {
      try {
        rel = JSON.parse(rel);
      } catch {
        rel = rel.slice(1, -1);
      }
    }
    rel = normalizePath(rel);
    if (!rel || seen.has(rel)) continue;
    seen.add(rel);
    out.push(rel);
  }
  return out.sort();
}

function gitChangedPaths() {
  const r = spawnSync('git', ['status', '--porcelain'], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  if (r.status !== 0) {
    throw new Error(`git_status_failed:${String(r.stderr || '').trim() || r.status}`);
  }
  return parseGitStatusPaths(r.stdout);
}

function classifyPaths(paths, churnExcludes) {
  const churn = [];
  const code = [];
  for (const p of paths || []) {
    if (pathMatchesAny(p, churnExcludes)) churn.push(p);
    else code.push(p);
  }
  return {
    all: Array.from(paths || []),
    code,
    churn,
    counts: {
      all: (paths || []).length,
      code: code.length,
      churn: churn.length
    }
  };
}

function readPolicy(policyPath) {
  const fallback = {
    version: '1.0-fallback',
    enforce_single_active_lever: true,
    require_code_changes_for_evaluate: true,
    metric_scope: 'checks_effective',
    performance: {
      min_drift_reduction: 0.003,
      min_yield_increase: 0.02,
      max_drift_increase: 0.001,
      max_yield_drop: 0.01,
      max_safety_stop_increase: 0
    },
    churn_excludes: [
      'state/**',
      'memory/.rebuild_delta_cache.json',
      'memory/MEMORY_INDEX.md',
      'memory/TAGS_INDEX.md',
      'memory/SNIPPET_INDEX.md'
    ]
  };
  const raw = readJsonSafe(policyPath, {}) || {};
  return {
    ...fallback,
    ...raw,
    performance: {
      ...fallback.performance,
      ...(raw.performance && typeof raw.performance === 'object' ? raw.performance : {})
    },
    churn_excludes: Array.isArray(raw.churn_excludes) && raw.churn_excludes.length > 0
      ? raw.churn_excludes.map((x) => normalizePath(x)).filter(Boolean)
      : fallback.churn_excludes
  };
}

function parseHarnessPayload(stdout) {
  const text = String(stdout || '').trim();
  if (!text) throw new Error('harness_output_empty');
  try {
    return JSON.parse(text);
  } catch {
    const firstJsonLine = text.split('\n').find((line) => String(line || '').trim().startsWith('{'));
    if (!firstJsonLine) throw new Error('harness_output_not_json');
    return JSON.parse(firstJsonLine);
  }
}

function runHarness({ dateStr, days, write }) {
  const harnessScript = process.env.LEVER_EXPERIMENT_HARNESS_SCRIPT
    ? path.resolve(String(process.env.LEVER_EXPERIMENT_HARNESS_SCRIPT))
    : DEFAULT_HARNESS_SCRIPT;
  const args = [harnessScript, 'run', dateStr, `--days=${days}`, `--write=${write ? 1 : 0}`];
  const r = spawnSync('node', args, {
    cwd: ROOT,
    encoding: 'utf8'
  });
  if (r.status !== 0) {
    const errOut = String(r.stderr || '').trim() || String(r.stdout || '').trim();
    throw new Error(`harness_exec_failed:${errOut || r.status}`);
  }
  const payload = parseHarnessPayload(r.stdout);
  if (!payload || payload.ok !== true || String(payload.type || '') !== 'autonomy_simulation_harness') {
    throw new Error('harness_payload_invalid');
  }
  return {
    payload,
    command: ['node', ...args.map((x) => String(x || ''))].join(' ')
  };
}

function metricSnapshot(payload, metricScope) {
  const sectionName = String(metricScope || 'checks_effective');
  const checks = payload && payload[sectionName] && typeof payload[sectionName] === 'object'
    ? payload[sectionName]
    : {};
  return {
    drift_rate: num(checks.drift_rate && checks.drift_rate.value),
    yield_rate: num(checks.yield_rate && checks.yield_rate.value),
    safety_stop_rate: num(checks.safety_stop_rate && checks.safety_stop_rate.value),
    section: sectionName
  };
}

function evaluateGate(baselinePayload, currentPayload, policy, opts = {}) {
  const p = policy && typeof policy === 'object' ? policy : {};
  const perf = p.performance && typeof p.performance === 'object' ? p.performance : {};
  const metricScope = String(p.metric_scope || 'checks_effective');
  const baseline = metricSnapshot(baselinePayload, metricScope);
  const current = metricSnapshot(currentPayload, metricScope);
  const deltas = {
    drift_rate: Number((current.drift_rate - baseline.drift_rate).toFixed(6)),
    yield_rate: Number((current.yield_rate - baseline.yield_rate).toFixed(6)),
    safety_stop_rate: Number((current.safety_stop_rate - baseline.safety_stop_rate).toFixed(6))
  };
  const thresholds = {
    min_drift_reduction: num(perf.min_drift_reduction, 0),
    min_yield_increase: num(perf.min_yield_increase, 0),
    max_drift_increase: num(perf.max_drift_increase, 0),
    max_yield_drop: num(perf.max_yield_drop, 0),
    max_safety_stop_increase: num(perf.max_safety_stop_increase, 0)
  };
  const liftChecks = {
    drift: (-deltas.drift_rate) >= thresholds.min_drift_reduction,
    yield: deltas.yield_rate >= thresholds.min_yield_increase
  };
  const requiredLift = liftChecks.drift || liftChecks.yield;
  const nonRegressionChecks = {
    drift: deltas.drift_rate <= thresholds.max_drift_increase,
    yield: deltas.yield_rate >= -thresholds.max_yield_drop,
    safety_stop: deltas.safety_stop_rate <= thresholds.max_safety_stop_increase
  };
  const nonRegression = nonRegressionChecks.drift && nonRegressionChecks.yield && nonRegressionChecks.safety_stop;
  const p1 = opts.p1 === true;
  const mode = p1 ? 'p1_or_nonregression' : 'performance_lift';
  const ok = p1 ? nonRegression : (requiredLift && nonRegression);

  const failures = [];
  if (!nonRegressionChecks.drift) failures.push('drift_regressed_over_max');
  if (!nonRegressionChecks.yield) failures.push('yield_regressed_over_max');
  if (!nonRegressionChecks.safety_stop) failures.push('safety_stop_regressed_over_max');
  if (!p1 && !requiredLift) failures.push('performance_lift_below_threshold');

  return {
    ok,
    mode,
    metric_scope: metricScope,
    p1_override: p1,
    baseline,
    current,
    deltas,
    thresholds,
    checks: {
      required_lift: requiredLift,
      lift: liftChecks,
      non_regression: nonRegression,
      non_regression_checks: nonRegressionChecks
    },
    failures
  };
}

function readActive() {
  return readJsonSafe(ACTIVE_EXPERIMENT_PATH, null);
}

function writeActive(active) {
  writeJson(ACTIVE_EXPERIMENT_PATH, active);
}

function clearActive() {
  if (fs.existsSync(ACTIVE_EXPERIMENT_PATH)) fs.unlinkSync(ACTIVE_EXPERIMENT_PATH);
}

function leverPath(lever) {
  return path.join(DEFAULT_WORK_DIR, `${lever}.json`);
}

function reportPath(lever) {
  ensureDir(REPORTS_DIR);
  const ts = nowIso().replace(/[:.]/g, '-');
  return path.join(REPORTS_DIR, `${ts}-${lever}.json`);
}

function validateLeverId(v) {
  const raw = String(v || '').trim();
  if (!raw) throw new Error('lever_required');
  if (!/^[a-z0-9][a-z0-9._-]{1,79}$/.test(raw)) {
    throw new Error('lever_invalid_format');
  }
  return raw;
}

function cmdScope(policy) {
  const changed = gitChangedPaths();
  const classified = classifyPaths(changed, policy.churn_excludes);
  const out = {
    ok: true,
    type: 'lever_experiment_scope',
    ts: nowIso(),
    policy_path: process.env.LEVER_EXPERIMENT_POLICY_PATH
      ? path.resolve(String(process.env.LEVER_EXPERIMENT_POLICY_PATH))
      : DEFAULT_POLICY_PATH,
    active_lever: readActive(),
    counts: classified.counts,
    code_changes: classified.code,
    churn_ignored: classified.churn
  };
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

function cmdStageCode(policy) {
  const changed = gitChangedPaths();
  const classified = classifyPaths(changed, policy.churn_excludes);
  const out = {
    ok: true,
    type: 'lever_experiment_stage_code',
    ts: nowIso(),
    counts: classified.counts,
    staged: [],
    churn_ignored: classified.churn
  };
  if (classified.code.length === 0) {
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    return;
  }
  const r = spawnSync('git', ['add', '--', ...classified.code], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  if (r.status !== 0) {
    throw new Error(`git_add_failed:${String(r.stderr || '').trim() || r.status}`);
  }
  out.staged = classified.code;
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

function cmdStart(args, policy) {
  const lever = validateLeverId(args.lever);
  const dateStr = String(args.date || todayStr());
  const days = toInt(args.days, 180, 1, 3650);
  const active = readActive();
  if (policy.enforce_single_active_lever && active && active.lever && active.lever !== lever) {
    throw new Error(`active_lever_exists:${active.lever}`);
  }

  const changed = gitChangedPaths();
  const classified = classifyPaths(changed, policy.churn_excludes);
  const allowDirtyCodeStart = toBool(args['allow-dirty-code-start'], false);
  if (!allowDirtyCodeStart && classified.code.length > 0) {
    throw new Error('code_changes_present_before_start');
  }

  const baselineRun = runHarness({ dateStr, days, write: false });
  const experiment = {
    ok: true,
    schema: 'lever_experiment.v1',
    status: 'active',
    lever,
    started_at: nowIso(),
    policy_hash: hashObj(policy),
    policy_version: String(policy.version || ''),
    baseline: {
      source: {
        date: dateStr,
        days,
        command: baselineRun.command
      },
      payload: baselineRun.payload,
      metrics: metricSnapshot(baselineRun.payload, policy.metric_scope)
    },
    scope_start: {
      counts: classified.counts,
      code_changes: classified.code,
      churn_ignored: classified.churn
    }
  };
  const fp = leverPath(lever);
  writeJson(fp, experiment);
  writeActive({
    lever,
    started_at: experiment.started_at,
    experiment_path: fp
  });
  const out = {
    ok: true,
    type: 'lever_experiment_start',
    ts: nowIso(),
    lever,
    experiment_path: fp,
    baseline_metrics: experiment.baseline.metrics,
    scope_start: experiment.scope_start,
    active: readActive()
  };
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

function cmdEvaluate(args, policy) {
  const lever = validateLeverId(args.lever);
  const dateStr = String(args.date || todayStr());
  const days = toInt(args.days, 180, 1, 3650);
  const p1 = toBool(args.p1, false);
  const p1Ref = String(args.p1_ref || '').trim() || null;

  const active = readActive();
  if (policy.enforce_single_active_lever) {
    if (!active || String(active.lever || '') !== lever) {
      throw new Error('active_lever_mismatch');
    }
  }

  const fp = leverPath(lever);
  const experiment = readJsonSafe(fp, null);
  if (!experiment || String(experiment.status || '') !== 'active') {
    throw new Error('experiment_not_active');
  }
  const baselinePayload = experiment.baseline && experiment.baseline.payload;
  if (!baselinePayload || typeof baselinePayload !== 'object') {
    throw new Error('baseline_missing');
  }

  const currentRun = runHarness({ dateStr, days, write: false });
  const gate = evaluateGate(baselinePayload, currentRun.payload, policy, { p1 });
  const changed = gitChangedPaths();
  const classified = classifyPaths(changed, policy.churn_excludes);
  const codeChangeGate = policy.require_code_changes_for_evaluate ? classified.code.length > 0 : true;
  if (!codeChangeGate) gate.failures.push('no_code_changes_detected');
  const ok = gate.ok && codeChangeGate;
  const completedAt = nowIso();

  experiment.status = 'completed';
  experiment.completed_at = completedAt;
  experiment.evaluate = {
    source: {
      date: dateStr,
      days,
      command: currentRun.command
    },
    payload: currentRun.payload,
    metrics: metricSnapshot(currentRun.payload, policy.metric_scope),
    gate,
    code_change_gate: codeChangeGate,
    scope_end: {
      counts: classified.counts,
      code_changes: classified.code,
      churn_ignored: classified.churn
    },
    p1_override: p1,
    p1_ref: p1Ref
  };
  experiment.ok = ok;
  writeJson(fp, experiment);

  const report = {
    ok,
    type: 'lever_experiment_evaluate',
    ts: completedAt,
    lever,
    experiment_path: fp,
    policy_hash: experiment.policy_hash,
    baseline_metrics: experiment.baseline.metrics,
    current_metrics: experiment.evaluate.metrics,
    gate,
    code_change_gate: codeChangeGate,
    scope_end: experiment.evaluate.scope_end,
    p1_override: p1,
    p1_ref: p1Ref
  };
  const reportFp = reportPath(lever);
  writeJson(reportFp, report);
  appendJsonl(HISTORY_PATH, {
    ts: completedAt,
    type: 'lever_experiment_result',
    lever,
    ok,
    report_path: reportFp,
    gate_mode: gate.mode,
    p1_override: p1,
    deltas: gate.deltas,
    failures: gate.failures.slice(0, 8)
  });
  clearActive();
  report.report_path = reportFp;
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  if (!ok) process.exit(2);
}

function cmdAbort(args) {
  const current = readActive();
  if (!current) {
    process.stdout.write(JSON.stringify({
      ok: true,
      type: 'lever_experiment_abort',
      ts: nowIso(),
      active_cleared: false
    }, null, 2) + '\n');
    return;
  }
  const expectedLever = String(args.lever || '').trim();
  if (expectedLever && expectedLever !== String(current.lever || '')) {
    throw new Error('abort_lever_mismatch');
  }
  clearActive();
  process.stdout.write(JSON.stringify({
    ok: true,
    type: 'lever_experiment_abort',
    ts: nowIso(),
    active_cleared: true,
    previous_active: current
  }, null, 2) + '\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim().toLowerCase();
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || args.help === true) {
    usage();
    return;
  }

  const policyPath = process.env.LEVER_EXPERIMENT_POLICY_PATH
    ? path.resolve(String(process.env.LEVER_EXPERIMENT_POLICY_PATH))
    : DEFAULT_POLICY_PATH;
  const policy = readPolicy(policyPath);

  if (cmd === 'scope') {
    cmdScope(policy);
    return;
  }
  if (cmd === 'stage-code') {
    cmdStageCode(policy);
    return;
  }
  if (cmd === 'start') {
    cmdStart(args, policy);
    return;
  }
  if (cmd === 'evaluate') {
    cmdEvaluate(args, policy);
    return;
  }
  if (cmd === 'abort') {
    cmdAbort(args);
    return;
  }
  usage();
  process.exit(2);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stdout.write(JSON.stringify({
      ok: false,
      error: shortErr(err, 'lever_experiment_gate_failed'),
      ts: nowIso()
    }) + '\n');
    process.exit(1);
  }
}

module.exports = {
  classifyPaths,
  evaluateGate,
  metricSnapshot,
  parseGitStatusPaths
};
