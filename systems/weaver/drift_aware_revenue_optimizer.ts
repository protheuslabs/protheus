#!/usr/bin/env node
'use strict';
export {};

/**
 * drift_aware_revenue_optimizer.js
 *
 * V3-BRG-003: optimize workflow/budget mix for value growth while enforcing drift + SLO envelopes.
 *
 * Usage:
 *   node systems/weaver/drift_aware_revenue_optimizer.js optimize [--strict=1|0]
 *   node systems/weaver/drift_aware_revenue_optimizer.js status [--days=30]
 */

const fs = require('fs');
const path = require('path');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = process.env.DRIFT_AWARE_REVENUE_OPTIMIZER_POLICY_PATH
  ? path.resolve(String(process.env.DRIFT_AWARE_REVENUE_OPTIMIZER_POLICY_PATH))
  : path.join(ROOT, 'config', 'drift_aware_revenue_optimizer_policy.json');

function nowIso() {
  return new Date().toISOString();
}

function clean(v: unknown, maxLen = 240) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeToken(v: unknown, maxLen = 120) {
  return clean(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.:/-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function clampNum(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function clampInt(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

function toBool(v: unknown, fallback = false) {
  if (v == null) return fallback;
  const raw = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (const tok of argv) {
    if (!String(tok || '').startsWith('--')) {
      out._.push(String(tok || ''));
      continue;
    }
    const idx = tok.indexOf('=');
    if (idx < 0) out[String(tok || '').slice(2)] = true;
    else out[String(tok || '').slice(2, idx)] = String(tok || '').slice(idx + 1);
  }
  return out;
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath: string, fallback: AnyObj = {}) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
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
      .filter(Boolean) as AnyObj[];
  } catch {
    return [];
  }
}

function writeJsonAtomic(filePath: string, payload: AnyObj) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${Date.now()}-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function appendJsonl(filePath: string, row: AnyObj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function rel(absPath: string) {
  return path.relative(ROOT, absPath).replace(/\\/g, '/');
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    strict_default: false,
    drift_cap_30d: 0.02,
    require_execution_slo_pass: true,
    execution_reliability_state_path: 'state/ops/execution_reliability_slo.json',
    high_value_latest_path: 'state/adaptive/workflows/high_value_play/latest.json',
    high_value_history_path: 'state/adaptive/workflows/high_value_play/history.jsonl',
    latest_path: 'state/weaver/drift_aware_revenue_optimizer/latest.json',
    history_path: 'state/weaver/drift_aware_revenue_optimizer/history.jsonl',
    receipts_path: 'state/weaver/drift_aware_revenue_optimizer/receipts.jsonl'
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const base = defaultPolicy();
  const raw = readJson(policyPath, {});
  const rootPath = (v: unknown, fallback: string) => {
    const text = clean(v || fallback, 320);
    return path.isAbsolute(text) ? path.resolve(text) : path.join(ROOT, text);
  };
  return {
    version: clean(raw.version || base.version, 24) || base.version,
    enabled: raw.enabled !== false,
    strict_default: toBool(raw.strict_default, base.strict_default),
    drift_cap_30d: clampNum(raw.drift_cap_30d, 0, 1, base.drift_cap_30d),
    require_execution_slo_pass: toBool(raw.require_execution_slo_pass, base.require_execution_slo_pass),
    execution_reliability_state_path: rootPath(raw.execution_reliability_state_path, base.execution_reliability_state_path),
    high_value_latest_path: rootPath(raw.high_value_latest_path, base.high_value_latest_path),
    high_value_history_path: rootPath(raw.high_value_history_path, base.high_value_history_path),
    latest_path: rootPath(raw.latest_path, base.latest_path),
    history_path: rootPath(raw.history_path, base.history_path),
    receipts_path: rootPath(raw.receipts_path, base.receipts_path),
    policy_path: path.resolve(policyPath)
  };
}

function computeSignals(policy: AnyObj) {
  const slo = readJson(policy.execution_reliability_state_path, {});
  const hvLatest = readJson(policy.high_value_latest_path, {});
  const hvHistory = readJsonl(policy.high_value_history_path);

  const topCandidates = Array.isArray(hvLatest.top_candidates) ? hvLatest.top_candidates : [];
  const driftRows = topCandidates.map((row: AnyObj) => Number(row && row.drift_risk || 0)).filter((n: number) => Number.isFinite(n));
  const rewardRows = topCandidates.map((row: AnyObj) => Number(row && row.reward_potential || 0)).filter((n: number) => Number.isFinite(n));
  const confidenceRows = topCandidates.map((row: AnyObj) => Number(row && row.confidence || 0)).filter((n: number) => Number.isFinite(n));
  const avg = (rows: number[]) => rows.length ? rows.reduce((a, b) => a + b, 0) / rows.length : 0;

  const driftLatest = clampNum(avg(driftRows), 0, 1, 0);
  const rewardLatest = clampNum(avg(rewardRows), 0, 1, 0);
  const confidenceLatest = clampNum(avg(confidenceRows), 0, 1, 0);
  const recentOutcomes = hvHistory
    .filter((row: AnyObj) => row && row.type === 'high_value_play_outcome')
    .slice(-200);
  const outcomeDrift = recentOutcomes
    .map((row: AnyObj) => Number(row && row.drift_risk || 0))
    .filter((n: number) => Number.isFinite(n));
  const drift30d = clampNum(outcomeDrift.length ? avg(outcomeDrift) : driftLatest, 0, 1, driftLatest);

  const executionSloPass = slo && (
    slo.pass === true
      || (slo.gates && slo.gates.execution_success_rate_ok === true
        && slo.gates.queue_drain_rate_ok === true
        && slo.gates.time_to_first_execution_ok === true
        && slo.gates.zero_shipped_streak_ok === true)
  );

  return {
    execution_slo_pass: executionSloPass === true,
    drift_latest: Number(driftLatest.toFixed(4)),
    drift_30d: Number(drift30d.toFixed(4)),
    reward_latest: Number(rewardLatest.toFixed(4)),
    confidence_latest: Number(confidenceLatest.toFixed(4)),
    candidate_count: topCandidates.length
  };
}

function choosePlan(policy: AnyObj, signals: AnyObj) {
  const driftCap = Number(policy.drift_cap_30d || 0.02);
  const sloRequired = policy.require_execution_slo_pass === true;
  const overDrift = Number(signals.drift_30d || 0) > driftCap;
  const sloBlocked = sloRequired && signals.execution_slo_pass !== true;
  const constrained = overDrift || sloBlocked;

  if (constrained) {
    return {
      mode: 'conservative',
      workflow_mix: {
        low_risk_repeatable: 0.7,
        medium_risk_growth: 0.25,
        high_risk_experiments: 0.05
      },
      budget_routing: {
        reliability_hardening: 0.5,
        revenue_execution: 0.35,
        experimentation: 0.15
      },
      reason_codes: [
        overDrift ? 'drift_cap_exceeded' : null,
        sloBlocked ? 'execution_slo_not_passing' : null
      ].filter(Boolean)
    };
  }

  const growthBias = clampNum((signals.reward_latest * 0.6) + (signals.confidence_latest * 0.4), 0, 1, 0.5);
  const highRisk = clampNum(0.08 + (growthBias * 0.18), 0.08, 0.26, 0.12);
  const mediumRisk = clampNum(0.26 + (growthBias * 0.2), 0.26, 0.5, 0.34);
  const lowRisk = clampNum(1 - highRisk - mediumRisk, 0.3, 0.7, 0.54);

  return {
    mode: 'balanced_growth',
    workflow_mix: {
      low_risk_repeatable: Number(lowRisk.toFixed(4)),
      medium_risk_growth: Number(mediumRisk.toFixed(4)),
      high_risk_experiments: Number(highRisk.toFixed(4))
    },
    budget_routing: {
      reliability_hardening: 0.28,
      revenue_execution: 0.5,
      experimentation: 0.22
    },
    reason_codes: ['drift_within_cap', 'execution_slo_passing']
  };
}

function cmdOptimize(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  if (!policy.enabled) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'drift_aware_revenue_optimize', error: 'policy_disabled' })}\n`);
    process.exit(1);
  }
  const strict = toBool(args.strict, policy.strict_default === true);
  const signals = computeSignals(policy);
  const plan = choosePlan(policy, signals);
  const driftCapOk = Number(signals.drift_30d || 0) <= Number(policy.drift_cap_30d || 0);
  const sloOk = policy.require_execution_slo_pass !== true || signals.execution_slo_pass === true;
  const ok = driftCapOk && sloOk;
  const out = {
    ok,
    type: 'drift_aware_revenue_optimize',
    ts: nowIso(),
    signals,
    plan,
    policy: {
      path: rel(policy.policy_path),
      drift_cap_30d: policy.drift_cap_30d,
      require_execution_slo_pass: policy.require_execution_slo_pass === true
    }
  };
  writeJsonAtomic(policy.latest_path, out);
  appendJsonl(policy.history_path, out);
  appendJsonl(policy.receipts_path, out);
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  if (strict && out.ok !== true) process.exit(1);
}

function cmdStatus(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const days = clampInt(args.days, 1, 365, 30);
  const latest = readJson(policy.latest_path, null);
  const history = readJsonl(policy.history_path);
  const cutoffMs = Date.now() - (days * 24 * 60 * 60 * 1000);
  const windowRows = history.filter((row: AnyObj) => {
    const ts = Date.parse(clean(row && row.ts || '', 40));
    return Number.isFinite(ts) && ts >= cutoffMs;
  });
  const driftRows = windowRows.map((row: AnyObj) => Number(row && row.signals && row.signals.drift_30d || 0)).filter((n: number) => Number.isFinite(n));
  const maxDrift = driftRows.length ? Math.max(...driftRows) : 0;
  const passRows = windowRows.filter((row: AnyObj) => row && row.ok === true).length;
  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'drift_aware_revenue_status',
    ts: nowIso(),
    days,
    latest,
    window_runs: windowRows.length,
    window_pass_rate: windowRows.length ? Number((passRows / windowRows.length).toFixed(4)) : 1,
    max_window_drift_30d: Number(maxDrift.toFixed(4)),
    policy: {
      path: rel(policy.policy_path),
      drift_cap_30d: policy.drift_cap_30d,
      require_execution_slo_pass: policy.require_execution_slo_pass === true
    },
    paths: {
      latest_path: rel(policy.latest_path),
      history_path: rel(policy.history_path),
      receipts_path: rel(policy.receipts_path)
    }
  }, null, 2)}\n`);
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/weaver/drift_aware_revenue_optimizer.js optimize [--strict=1|0]');
  console.log('  node systems/weaver/drift_aware_revenue_optimizer.js status [--days=30]');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || '', 40);
  if (!cmd || cmd === 'help' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'optimize') return cmdOptimize(args);
  if (cmd === 'status') return cmdStatus(args);
  usage();
  process.exit(2);
}

if (require.main === module) {
  main();
}
