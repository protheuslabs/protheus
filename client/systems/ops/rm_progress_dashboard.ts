#!/usr/bin/env node
'use strict';
export {};

/**
 * RM progress dashboard aggregator.
 *
 * Consolidates key execution-gap closure artifacts into a single ops state:
 * - RM-113 workflow execution closure
 * - RM-119 execution reliability SLO
 * - RM-001 CI baseline guard
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = process.env.RM_PROGRESS_DASHBOARD_POLICY_PATH
  ? path.resolve(process.env.RM_PROGRESS_DASHBOARD_POLICY_PATH)
  : path.join(ROOT, 'config', 'rm_progress_dashboard_policy.json');
const DEFAULT_STATE_PATH = process.env.RM_PROGRESS_DASHBOARD_STATE_PATH
  ? path.resolve(process.env.RM_PROGRESS_DASHBOARD_STATE_PATH)
  : path.join(ROOT, 'state', 'ops', 'rm_progress_dashboard.json');
const DEFAULT_HISTORY_PATH = process.env.RM_PROGRESS_DASHBOARD_HISTORY_PATH
  ? path.resolve(process.env.RM_PROGRESS_DASHBOARD_HISTORY_PATH)
  : path.join(ROOT, 'state', 'ops', 'rm_progress_dashboard_history.jsonl');

type AnyObj = Record<string, any>;

function nowIso() {
  return new Date().toISOString();
}

function todayUtc() {
  return nowIso().slice(0, 10);
}

function toDate(raw: unknown) {
  const s = String(raw || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return todayUtc();
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (const tok of argv) {
    if (!String(tok).startsWith('--')) {
      out._.push(String(tok));
      continue;
    }
    const idx = String(tok).indexOf('=');
    if (idx === -1) {
      out[String(tok).slice(2)] = true;
      continue;
    }
    out[String(tok).slice(2, idx)] = String(tok).slice(idx + 1);
  }
  return out;
}

function toBool(v: unknown, fallback = false) {
  if (v == null) return fallback;
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  return fallback;
}

function clampInt(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

function readJson(filePath: string, fallback: any) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeJsonAtomic(filePath: string, value: AnyObj) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${Date.now()}-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function appendJsonl(filePath: string, row: AnyObj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function relPath(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function trimHistory(historyPath: string, maxRows: number) {
  if (!fs.existsSync(historyPath)) return;
  const lines = String(fs.readFileSync(historyPath, 'utf8') || '')
    .split('\n')
    .filter(Boolean);
  if (lines.length <= maxRows) return;
  fs.writeFileSync(historyPath, `${lines.slice(lines.length - maxRows).join('\n')}\n`, 'utf8');
}

function defaultPolicy() {
  return {
    version: '1.0',
    max_history_rows: 400,
    auto_refresh_sources: false,
    refresh_timeout_ms: 30000,
    sources: {
      rm113_closure_path: 'state/ops/workflow_execution_closure.json',
      rm119_reliability_path: 'state/ops/execution_reliability_slo.json',
      rm001_ci_guard_path: 'state/ops/ci_baseline_guard.json'
    },
    refresh_scripts: {
      rm113: 'systems/ops/workflow_execution_closure.js',
      rm119: 'systems/ops/execution_reliability_slo.js',
      rm001: 'systems/ops/ci_baseline_guard.js'
    }
  };
}

function resolvePath(raw: unknown, fallbackRel: string) {
  const value = String(raw == null ? '' : raw).trim();
  if (!value) return path.join(ROOT, fallbackRel);
  return path.isAbsolute(value) ? value : path.join(ROOT, value);
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const sources = raw && raw.sources && typeof raw.sources === 'object'
    ? raw.sources
    : {};
  const refreshScripts = raw && raw.refresh_scripts && typeof raw.refresh_scripts === 'object'
    ? raw.refresh_scripts
    : {};
  return {
    version: String(raw && raw.version || base.version),
    max_history_rows: clampInt(raw && raw.max_history_rows, 20, 5000, base.max_history_rows),
    auto_refresh_sources: toBool(raw && raw.auto_refresh_sources, base.auto_refresh_sources),
    refresh_timeout_ms: clampInt(raw && raw.refresh_timeout_ms, 1000, 120000, base.refresh_timeout_ms),
    sources: {
      rm113_closure_path: resolvePath(sources.rm113_closure_path, base.sources.rm113_closure_path),
      rm119_reliability_path: resolvePath(sources.rm119_reliability_path, base.sources.rm119_reliability_path),
      rm001_ci_guard_path: resolvePath(sources.rm001_ci_guard_path, base.sources.rm001_ci_guard_path)
    },
    refresh_scripts: {
      rm113: resolvePath(refreshScripts.rm113, base.refresh_scripts.rm113),
      rm119: resolvePath(refreshScripts.rm119, base.refresh_scripts.rm119),
      rm001: resolvePath(refreshScripts.rm001, base.refresh_scripts.rm001)
    }
  };
}

function runRefreshScript(scriptPath: string, date: string, timeoutMs: number, disabled = false) {
  if (disabled) {
    return {
      ok: true,
      skipped: true,
      reason: 'disabled'
    };
  }
  if (!fs.existsSync(scriptPath)) {
    return {
      ok: false,
      skipped: false,
      reason: 'script_missing',
      script_path: relPath(scriptPath)
    };
  }
  const proc = spawnSync(process.execPath, [scriptPath, 'run', date], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: timeoutMs
  });
  const code = proc.status == null ? 1 : proc.status;
  const ok = code === 0;
  return {
    ok,
    skipped: false,
    code,
    signal: proc.signal ? String(proc.signal) : '',
    script_path: relPath(scriptPath),
    stdout_tail: String(proc.stdout || '').slice(-240),
    stderr_tail: String(proc.stderr || '').slice(-240)
  };
}

function computeStatus(checks: AnyObj) {
  const values = Object.values(checks).map((v) => v === true);
  const passed = values.filter(Boolean).length;
  const total = values.length;
  const ratio = total > 0 ? passed / total : 0;
  const allPass = total > 0 && passed === total;
  const nonePass = passed === 0;
  return {
    all_pass: allPass,
    passed_count: passed,
    total_count: total,
    pass_ratio: ratio,
    result: allPass ? 'pass' : (nonePass ? 'fail' : 'partial')
  };
}

function runDashboard(args: AnyObj) {
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  const date = toDate(args._[1] || args.date);
  const strict = toBool(args.strict, false);
  const skipRefresh = toBool(args['skip-refresh'] ?? args.skip_refresh, false);
  const statePath = args['state-path'] ? path.resolve(String(args['state-path'])) : DEFAULT_STATE_PATH;
  const historyPath = args['history-path'] ? path.resolve(String(args['history-path'])) : DEFAULT_HISTORY_PATH;

  const refreshResults = {
    enabled: policy.auto_refresh_sources === true && !skipRefresh,
    rm113: runRefreshScript(policy.refresh_scripts.rm113, date, policy.refresh_timeout_ms, !(policy.auto_refresh_sources === true && !skipRefresh)),
    rm119: runRefreshScript(policy.refresh_scripts.rm119, date, policy.refresh_timeout_ms, !(policy.auto_refresh_sources === true && !skipRefresh)),
    rm001: runRefreshScript(policy.refresh_scripts.rm001, date, policy.refresh_timeout_ms, !(policy.auto_refresh_sources === true && !skipRefresh))
  };

  const rm113 = readJson(policy.sources.rm113_closure_path, null);
  const rm119 = readJson(policy.sources.rm119_reliability_path, null);
  const rm001 = readJson(policy.sources.rm001_ci_guard_path, null);

  const checks = {
    rm113_workflow_execution_closure: !!(rm113 && (rm113.closure_pass === true || rm113.pass === true)),
    rm119_execution_reliability_slo: !!(rm119 && rm119.pass === true),
    rm001_ci_baseline_guard: !!(rm001 && rm001.pass === true)
  };

  const status = computeStatus(checks);
  const blockedBy = Object.keys(checks).filter((k) => checks[k] !== true);

  const summary = {
    rm113: {
      available: !!rm113,
      pass: checks.rm113_workflow_execution_closure,
      consecutive_days_passed: Number(rm113 && rm113.consecutive_days_passed || 0),
      target_streak_days: Number(rm113 && rm113.target_streak_days || 0),
      remaining_days: Number(rm113 && rm113.remaining_days || 0),
      result: rm113 && rm113.result ? String(rm113.result) : null
    },
    rm119: {
      available: !!rm119,
      pass: checks.rm119_execution_reliability_slo,
      window_days: Number(rm119 && rm119.window_days || 0),
      live_runs: Number(rm119 && rm119.live_runs || 0),
      execution_success_rate: Number(rm119 && rm119.measured && rm119.measured.execution_success_rate || 0),
      queue_drain_rate: Number(rm119 && rm119.measured && rm119.measured.queue_drain_rate || 0),
      zero_shipped_streak_days: Number(rm119 && rm119.measured && rm119.measured.zero_shipped_streak_days || 0),
      result: rm119 && rm119.result ? String(rm119.result) : null
    },
    rm001: {
      available: !!rm001,
      pass: checks.rm001_ci_baseline_guard,
      streak: Number(rm001 && rm001.streak || 0),
      target_days: Number(rm001 && rm001.target_days || 0),
      latest_run_ok: rm001 && rm001.latest_run_ok === true,
      latest_run_lag_days: rm001 && rm001.latest_run_lag_days != null
        ? Number(rm001.latest_run_lag_days)
        : null,
      result: rm001 && rm001.result ? String(rm001.result) : null
    }
  };

  const payload = {
    ok: true,
    type: 'rm_progress_dashboard',
    ts: nowIso(),
    date,
    policy_path: relPath(policyPath),
    policy_version: policy.version,
    checks,
    status,
    blocked_by: blockedBy,
    summary,
    refresh: refreshResults,
    source_paths: {
      rm113_closure_path: relPath(policy.sources.rm113_closure_path),
      rm119_reliability_path: relPath(policy.sources.rm119_reliability_path),
      rm001_ci_guard_path: relPath(policy.sources.rm001_ci_guard_path)
    },
    state_path: relPath(statePath),
    history_path: relPath(historyPath)
  };

  writeJsonAtomic(statePath, {
    schema_id: 'rm_progress_dashboard',
    schema_version: '1.0',
    updated_at: payload.ts,
    date: payload.date,
    policy_version: payload.policy_version,
    checks: payload.checks,
    status: payload.status,
    blocked_by: payload.blocked_by,
    summary: payload.summary,
    refresh: payload.refresh
  });
  appendJsonl(historyPath, {
    ts: payload.ts,
    date: payload.date,
    checks: payload.checks,
    status: payload.status,
    blocked_by: payload.blocked_by
  });
  trimHistory(historyPath, policy.max_history_rows);

  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  if (strict && !status.all_pass) process.exit(1);
}

function statusDashboard() {
  const payload = readJson(DEFAULT_STATE_PATH, null);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'rm_progress_dashboard_status',
    ts: nowIso(),
    available: !!payload,
    state_path: relPath(DEFAULT_STATE_PATH),
    payload: payload && typeof payload === 'object' ? payload : null
  }, null, 2)}\n`);
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/rm_progress_dashboard.js run [YYYY-MM-DD] [--strict=1]');
  console.log('  node systems/ops/rm_progress_dashboard.js status');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || 'run').trim().toLowerCase();
  if (cmd === 'run') return runDashboard(args);
  if (cmd === 'status') return statusDashboard();
  usage();
  process.exit(1);
}

main();
