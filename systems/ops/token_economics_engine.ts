#!/usr/bin/env node
'use strict';
export {};

/**
 * V2-BRG-001
 * Smart token economics lane that forecasts burn pressure from workflow
 * executor history and emits preemptive throttle/defer guidance.
 */

const fs = require('fs');
const path = require('path');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = process.env.TOKEN_ECONOMICS_ENGINE_POLICY_PATH
  ? path.resolve(process.env.TOKEN_ECONOMICS_ENGINE_POLICY_PATH)
  : path.join(ROOT, 'config', 'token_economics_engine_policy.json');

function nowIso() {
  return new Date().toISOString();
}

function toDate(raw: unknown) {
  const text = String(raw || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  return nowIso().slice(0, 10);
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (const tok of argv) {
    const raw = String(tok || '');
    if (!raw.startsWith('--')) {
      out._.push(raw);
      continue;
    }
    const idx = raw.indexOf('=');
    if (idx === -1) out[raw.slice(2)] = true;
    else out[raw.slice(2, idx)] = raw.slice(idx + 1);
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

function clampNumber(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function readJson(filePath: string, fallback: any) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function readJsonl(filePath: string) {
  try {
    if (!fs.existsSync(filePath)) return [];
    return String(fs.readFileSync(filePath, 'utf8') || '')
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

function percentile(values: number[], q: number) {
  const rows = values.filter((n) => Number.isFinite(n)).slice(0).sort((a, b) => a - b);
  if (!rows.length) return null;
  const qq = clampNumber(q, 0, 1, 0.95);
  const idx = Math.min(rows.length - 1, Math.max(0, Math.ceil(qq * rows.length) - 1));
  return Number(rows[idx].toFixed(3));
}

function average(values: number[]) {
  const rows = values.filter((n) => Number.isFinite(n));
  if (!rows.length) return 0;
  return Number((rows.reduce((acc, n) => acc + n, 0) / rows.length).toFixed(3));
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    rolling_runs: 40,
    max_defer_ratio: 0.35,
    max_autopause_preflight_ratio: 0.2,
    max_predicted_tokens_per_run: 2500,
    base_throttle_ratio: 0.85,
    min_critical_lane_share: 0.2,
    paths: {
      workflow_history: 'state/adaptive/workflows/executor/history.jsonl',
      state: 'state/ops/token_economics_engine.json',
      history: 'state/ops/token_economics_engine_history.jsonl'
    }
  };
}

function resolvePath(raw: unknown, fallbackRel: string) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return path.join(ROOT, fallbackRel);
  return path.isAbsolute(text) ? text : path.join(ROOT, text);
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const pathsCfg = raw && raw.paths && typeof raw.paths === 'object'
    ? raw.paths
    : {};
  return {
    version: String(raw && raw.version || base.version),
    enabled: raw && raw.enabled !== false,
    rolling_runs: clampInt(raw && raw.rolling_runs, 1, 5000, base.rolling_runs),
    max_defer_ratio: clampNumber(raw && raw.max_defer_ratio, 0, 1, base.max_defer_ratio),
    max_autopause_preflight_ratio: clampNumber(
      raw && raw.max_autopause_preflight_ratio,
      0,
      1,
      base.max_autopause_preflight_ratio
    ),
    max_predicted_tokens_per_run: clampNumber(
      raw && raw.max_predicted_tokens_per_run,
      1,
      1_000_000,
      base.max_predicted_tokens_per_run
    ),
    base_throttle_ratio: clampNumber(raw && raw.base_throttle_ratio, 0.05, 1, base.base_throttle_ratio),
    min_critical_lane_share: clampNumber(raw && raw.min_critical_lane_share, 0, 1, base.min_critical_lane_share),
    paths: {
      workflow_history: resolvePath(pathsCfg.workflow_history, base.paths.workflow_history),
      state: resolvePath(pathsCfg.state, base.paths.state),
      history: resolvePath(pathsCfg.history, base.paths.history)
    }
  };
}

function summarizeRows(rows: AnyObj[]) {
  const predictedRows: number[] = [];
  const capRows: number[] = [];
  let deferRuns = 0;
  let autopauseRuns = 0;
  const reasons: AnyObj = {};
  for (const row of rows) {
    const tok = row && row.token_economics && typeof row.token_economics === 'object'
      ? row.token_economics
      : {};
    const predicted = Number(tok.predicted_total_tokens || 0);
    const cap = Number(tok.run_token_cap_tokens || 0);
    if (Number.isFinite(predicted) && predicted >= 0) predictedRows.push(predicted);
    if (Number.isFinite(cap) && cap >= 0) capRows.push(cap);
    const deferredCount = Number(tok.deferred_count || 0);
    if (deferredCount > 0) deferRuns += 1;
    const reasonMap = tok.deferred_by_reason && typeof tok.deferred_by_reason === 'object'
      ? tok.deferred_by_reason
      : {};
    for (const [reasonRaw, countRaw] of Object.entries(reasonMap)) {
      const reason = String(reasonRaw || '').trim() || 'unknown';
      const count = Math.max(0, Number(countRaw || 0));
      reasons[reason] = Number(reasons[reason] || 0) + count;
    }
    if (Number(reasonMap.budget_autopause_active_preflight || 0) > 0) autopauseRuns += 1;
  }
  const total = rows.length;
  const deferRatio = total > 0 ? Number((deferRuns / total).toFixed(4)) : 0;
  const autopauseRatio = total > 0 ? Number((autopauseRuns / total).toFixed(4)) : 0;
  return {
    runs: total,
    defer_runs: deferRuns,
    defer_ratio: deferRatio,
    autopause_preflight_runs: autopauseRuns,
    autopause_preflight_ratio: autopauseRatio,
    predicted_tokens_avg: average(predictedRows),
    predicted_tokens_p95: percentile(predictedRows, 0.95),
    run_cap_tokens_avg: average(capRows),
    deferred_by_reason: reasons
  };
}

function decide(summary: AnyObj, policy: AnyObj) {
  const checks = {
    defer_ratio: Number(summary.defer_ratio || 0) <= Number(policy.max_defer_ratio || 0.35),
    autopause_preflight_ratio: Number(summary.autopause_preflight_ratio || 0) <= Number(policy.max_autopause_preflight_ratio || 0.2),
    predicted_tokens: Number(summary.predicted_tokens_avg || 0) <= Number(policy.max_predicted_tokens_per_run || 2500)
  };
  const blockers = Object.entries(checks)
    .filter(([, ok]) => ok !== true)
    .map(([k]) => k);
  const throttleCandidate = blockers.length > 0;
  const predictedPressure = Number(summary.predicted_tokens_avg || 0) / Math.max(1, Number(policy.max_predicted_tokens_per_run || 2500));
  const deferPressure = Number(summary.defer_ratio || 0) / Math.max(0.0001, Number(policy.max_defer_ratio || 0.35));
  const pressure = Math.max(predictedPressure, deferPressure, Number(summary.autopause_preflight_ratio || 0));
  const throttleRatio = throttleCandidate
    ? Number(Math.max(0.1, Number(policy.base_throttle_ratio || 0.85) - ((pressure - 1) * 0.2)).toFixed(4))
    : 1;
  const decision = throttleCandidate ? 'throttle' : 'allow';
  return {
    checks,
    blockers,
    decision,
    recommendations: {
      throttle_ratio: throttleRatio,
      queue_mode: throttleCandidate ? 'defer_non_critical' : 'normal',
      preserve_critical_lane_share: Number(policy.min_critical_lane_share || 0.2)
    }
  };
}

function runEngine(args: AnyObj) {
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  const date = toDate(args.date || args._[1]);
  const strict = toBool(args.strict, false);
  const rows = readJsonl(policy.paths.workflow_history)
    .filter((row: AnyObj) => row && typeof row === 'object')
    .slice(Math.max(0, Number(policy.rolling_runs || 40) * -1));

  const summary = summarizeRows(rows);
  const decision = decide(summary, policy);
  const pass = policy.enabled === true && decision.decision === 'allow';

  const payload = {
    ok: true,
    type: 'token_economics_engine',
    ts: nowIso(),
    date,
    policy_path: relPath(policyPath),
    policy_version: policy.version,
    rolling_runs: Number(policy.rolling_runs || 40),
    checks: decision.checks,
    blockers: decision.blockers,
    decision: decision.decision,
    recommendations: decision.recommendations,
    summary,
    pass,
    result: pass ? 'allow' : 'throttle',
    workflow_history_path: relPath(policy.paths.workflow_history),
    state_path: relPath(policy.paths.state),
    history_path: relPath(policy.paths.history)
  };

  writeJsonAtomic(policy.paths.state, {
    schema_id: 'token_economics_engine',
    schema_version: '1.0',
    updated_at: payload.ts,
    date: payload.date,
    policy_version: payload.policy_version,
    rolling_runs: payload.rolling_runs,
    checks: payload.checks,
    blockers: payload.blockers,
    decision: payload.decision,
    recommendations: payload.recommendations,
    summary: payload.summary,
    result: payload.result
  });
  appendJsonl(policy.paths.history, {
    ts: payload.ts,
    date: payload.date,
    decision: payload.decision,
    blockers: payload.blockers,
    summary: {
      runs: payload.summary.runs,
      defer_ratio: payload.summary.defer_ratio,
      autopause_preflight_ratio: payload.summary.autopause_preflight_ratio,
      predicted_tokens_avg: payload.summary.predicted_tokens_avg
    },
    recommendations: payload.recommendations
  });

  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  if (strict && payload.decision !== 'allow') process.exit(1);
}

function statusEngine(args: AnyObj) {
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  const payload = readJson(policy.paths.state, null);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'token_economics_engine_status',
    ts: nowIso(),
    available: !!payload,
    policy_path: relPath(policyPath),
    state_path: relPath(policy.paths.state),
    history_path: relPath(policy.paths.history),
    payload: payload && typeof payload === 'object' ? payload : null
  }, null, 2)}\n`);
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/token_economics_engine.js run [--strict=1]');
  console.log('  node systems/ops/token_economics_engine.js status');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || 'run').trim().toLowerCase();
  if (cmd === 'run') {
    runEngine(args);
    return;
  }
  if (cmd === 'status' || cmd === 'latest') {
    statusEngine(args);
    return;
  }
  usage();
  process.exit(2);
}

main();

