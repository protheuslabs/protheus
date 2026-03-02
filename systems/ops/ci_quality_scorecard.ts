#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');
const {
  ROOT,
  nowIso,
  parseArgs,
  cleanText,
  toBool,
  readJson,
  writeJsonAtomic,
  appendJsonl,
  resolvePath,
  emit
} = require('../../lib/queued_backlog_runtime');

const DEFAULT_POLICY_PATH = process.env.CI_QUALITY_SCORECARD_POLICY_PATH
  ? path.resolve(process.env.CI_QUALITY_SCORECARD_POLICY_PATH)
  : path.join(ROOT, 'config', 'ci_quality_scorecard_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/ci_quality_scorecard.js check [--strict=1|0] [--critical-suite-pass=1|0] [--coverage-pct=<n>] [--duration-ms=<n>]');
  console.log('  node systems/ops/ci_quality_scorecard.js status');
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    thresholds: {
      min_coverage_pct: 0,
      max_flake_rate: 0.05,
      max_p95_runtime_ms: 360000,
      require_critical_suite_pass: true
    },
    history_window: 50,
    paths: {
      history_path: 'state/ops/ci_quality_scorecard/history.jsonl',
      latest_path: 'state/ops/ci_quality_scorecard/latest.json',
      baseline_state_path: 'state/ops/ci_baseline_streak.json'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const thresholds = raw.thresholds && typeof raw.thresholds === 'object' ? raw.thresholds : {};
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  return {
    version: cleanText(raw.version || base.version, 24) || base.version,
    enabled: toBool(raw.enabled, true),
    thresholds: {
      min_coverage_pct: Number.isFinite(Number(thresholds.min_coverage_pct)) ? Number(thresholds.min_coverage_pct) : base.thresholds.min_coverage_pct,
      max_flake_rate: Number.isFinite(Number(thresholds.max_flake_rate)) ? Number(thresholds.max_flake_rate) : base.thresholds.max_flake_rate,
      max_p95_runtime_ms: Number.isFinite(Number(thresholds.max_p95_runtime_ms)) ? Number(thresholds.max_p95_runtime_ms) : base.thresholds.max_p95_runtime_ms,
      require_critical_suite_pass: toBool(thresholds.require_critical_suite_pass, base.thresholds.require_critical_suite_pass)
    },
    history_window: Number.isFinite(Number(raw.history_window)) ? Math.max(5, Math.floor(Number(raw.history_window))) : base.history_window,
    paths: {
      history_path: resolvePath(paths.history_path, base.paths.history_path),
      latest_path: resolvePath(paths.latest_path, base.paths.latest_path),
      baseline_state_path: resolvePath(paths.baseline_state_path, base.paths.baseline_state_path)
    }
  };
}

function readJsonl(filePath: string) {
  try {
    if (!fs.existsSync(filePath)) return [];
    return String(fs.readFileSync(filePath, 'utf8') || '')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function p95(values: number[]) {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const idx = Math.max(0, Math.ceil(sorted.length * 0.95) - 1);
  return Number(sorted[idx]);
}

function parseNumber(value: unknown, fallback: number | null) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return n;
}

function runCheck(policy: any, strict: boolean, args: any) {
  const criticalSuitePass = toBool(args['critical-suite-pass'], true);
  const coveragePct = parseNumber(args['coverage-pct'] ?? process.env.CI_COVERAGE_PCT, null);
  const durationMs = parseNumber(args['duration-ms'] ?? process.env.CI_JOB_DURATION_MS, null);

  const baseline = readJson(policy.paths.baseline_state_path, {});
  const history = readJsonl(policy.paths.history_path);

  const row = {
    ts: nowIso(),
    critical_suite_pass: criticalSuitePass,
    coverage_pct: coveragePct,
    duration_ms: durationMs,
    ci_consecutive_green_days: Number(baseline && baseline.consecutive_daily_green_runs || 0)
  };
  appendJsonl(policy.paths.history_path, row);

  const windowRows = readJsonl(policy.paths.history_path).slice(-policy.history_window);
  const failCount = windowRows.filter((r: any) => r && r.critical_suite_pass === false).length;
  const flakeRate = windowRows.length > 0 ? Number((failCount / windowRows.length).toFixed(6)) : 0;
  const p95Runtime = p95(windowRows.map((r: any) => Number(r && r.duration_ms)));
  const latestCoverage = coveragePct == null
    ? Number(windowRows.slice().reverse().find((r: any) => Number.isFinite(Number(r && r.coverage_pct)))?.coverage_pct ?? NaN)
    : coveragePct;

  const checks = {
    critical_suite_pass: criticalSuitePass === true || policy.thresholds.require_critical_suite_pass !== true,
    coverage_floor: Number.isFinite(latestCoverage) ? latestCoverage >= Number(policy.thresholds.min_coverage_pct) : policy.thresholds.min_coverage_pct <= 0,
    flake_rate_budget: flakeRate <= Number(policy.thresholds.max_flake_rate),
    runtime_budget: Number.isFinite(p95Runtime) ? p95Runtime <= Number(policy.thresholds.max_p95_runtime_ms) : true
  };

  const blocking = Object.entries(checks).filter(([, ok]) => ok !== true).map(([key]) => key);
  const pass = blocking.length === 0;
  const ok = strict ? pass : true;

  const out = {
    ok,
    pass,
    strict,
    type: 'ci_quality_scorecard',
    ts: nowIso(),
    checks,
    blocking_checks: blocking,
    metrics: {
      coverage_pct: Number.isFinite(latestCoverage) ? latestCoverage : null,
      flake_rate: flakeRate,
      p95_runtime_ms: Number.isFinite(Number(p95Runtime)) ? Number(p95Runtime) : null,
      critical_suite_pass: criticalSuitePass
    },
    thresholds: policy.thresholds,
    history_window: policy.history_window,
    rows_considered: windowRows.length,
    baseline_ci_streak_days: Number(baseline && baseline.consecutive_daily_green_runs || 0)
  };

  writeJsonAtomic(policy.paths.latest_path, out);
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || 'check').toLowerCase();
  if (args.help || cmd === 'help' || cmd === '--help') {
    usage();
    return emit({ ok: true, help: true }, 0);
  }

  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);

  if (cmd === 'status') {
    return emit(readJson(policy.paths.latest_path, {
      ok: true,
      type: 'ci_quality_scorecard',
      status: 'no_status'
    }), 0);
  }

  if (cmd !== 'check') {
    usage();
    return emit({ ok: false, error: `unknown_command:${cmd}` }, 1);
  }

  const strict = toBool(args.strict, true);
  const out = runCheck(policy, strict, args);
  return emit(out, out.ok ? 0 : 1);
}

main();
