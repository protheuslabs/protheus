#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-FCH-001
 * Error-budget release freeze gate.
 *
 * Usage:
 *   node systems/ops/error_budget_release_gate.js gate [--strict=1|0]
 *   node systems/ops/error_budget_release_gate.js run  [--strict=1|0]
 *   node systems/ops/error_budget_release_gate.js status
 */

const fs = require('fs');
const path = require('path');

type AnyObj = Record<string, any>;

const ROOT = process.env.ERROR_BUDGET_RELEASE_ROOT
  ? path.resolve(process.env.ERROR_BUDGET_RELEASE_ROOT)
  : path.resolve(__dirname, '..', '..');

const DEFAULT_POLICY_PATH = process.env.ERROR_BUDGET_RELEASE_POLICY_PATH
  ? path.resolve(process.env.ERROR_BUDGET_RELEASE_POLICY_PATH)
  : path.join(ROOT, 'config', 'error_budget_release_gate_policy.json');

function nowIso() {
  return new Date().toISOString();
}

function cleanText(v: unknown, maxLen = 220) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function toBool(v: unknown, fallback = false) {
  if (v == null) return fallback;
  const raw = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function clampNumber(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (const token of argv) {
    if (!String(token || '').startsWith('--')) {
      out._.push(String(token || ''));
      continue;
    }
    const idx = token.indexOf('=');
    if (idx < 0) out[String(token).slice(2)] = true;
    else out[String(token).slice(2, idx)] = String(token).slice(idx + 1);
  }
  return out;
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/error_budget_release_gate.js gate [--strict=1|0] [--policy=path]');
  console.log('  node systems/ops/error_budget_release_gate.js run [--strict=1|0] [--policy=path]');
  console.log('  node systems/ops/error_budget_release_gate.js status [--policy=path]');
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function resolvePath(raw: unknown, fallbackRel: string) {
  const token = cleanText(raw || '', 500);
  if (!token) return path.join(ROOT, fallbackRel);
  return path.isAbsolute(token) ? token : path.join(ROOT, token);
}

function readJson(filePath: string, fallback: any) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
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

function rel(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function defaultPolicy() {
  return {
    schema_id: 'error_budget_release_gate_policy',
    schema_version: '1.0',
    enabled: true,
    shadow_only: false,
    strict_default: true,
    budget: {
      max_burn_ratio: 0.45,
      warn_burn_ratio: 0.25,
      missing_signal_penalty: true
    },
    sources: {
      execution_reliability_path: 'state/ops/execution_reliability_slo.json',
      continuous_chaos_latest_path: 'state/ops/continuous_chaos_resilience/latest.json',
      execution_doctor_latest_path: 'state/ops/execution_doctor_ga/latest.json',
      operational_maturity_latest_path: 'state/ops/operational_maturity_closure/latest.json'
    },
    weights: {
      execution_reliability: 0.4,
      chaos_resilience: 0.3,
      execution_doctor_ga: 0.15,
      operational_maturity: 0.15
    },
    outputs: {
      latest_path: 'state/ops/error_budget_release_gate/latest.json',
      history_path: 'state/ops/error_budget_release_gate/history.jsonl',
      freeze_state_path: 'state/ops/error_budget_release_gate/freeze_state.json'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const base = defaultPolicy();
  const raw = readJson(policyPath, {});
  const budget = raw.budget && typeof raw.budget === 'object' ? raw.budget : {};
  const sources = raw.sources && typeof raw.sources === 'object' ? raw.sources : {};
  const weights = raw.weights && typeof raw.weights === 'object' ? raw.weights : {};
  const outputs = raw.outputs && typeof raw.outputs === 'object' ? raw.outputs : {};
  return {
    schema_id: 'error_budget_release_gate_policy',
    schema_version: cleanText(raw.schema_version || base.schema_version, 24) || base.schema_version,
    enabled: raw.enabled !== false,
    shadow_only: toBool(raw.shadow_only, base.shadow_only),
    strict_default: toBool(raw.strict_default, base.strict_default),
    budget: {
      max_burn_ratio: clampNumber(budget.max_burn_ratio, 0, 10, base.budget.max_burn_ratio),
      warn_burn_ratio: clampNumber(budget.warn_burn_ratio, 0, 10, base.budget.warn_burn_ratio),
      missing_signal_penalty: toBool(budget.missing_signal_penalty, base.budget.missing_signal_penalty)
    },
    sources: {
      execution_reliability_path: resolvePath(sources.execution_reliability_path, base.sources.execution_reliability_path),
      continuous_chaos_latest_path: resolvePath(sources.continuous_chaos_latest_path, base.sources.continuous_chaos_latest_path),
      execution_doctor_latest_path: resolvePath(sources.execution_doctor_latest_path, base.sources.execution_doctor_latest_path),
      operational_maturity_latest_path: resolvePath(sources.operational_maturity_latest_path, base.sources.operational_maturity_latest_path)
    },
    weights: {
      execution_reliability: clampNumber(weights.execution_reliability, 0, 1, base.weights.execution_reliability),
      chaos_resilience: clampNumber(weights.chaos_resilience, 0, 1, base.weights.chaos_resilience),
      execution_doctor_ga: clampNumber(weights.execution_doctor_ga, 0, 1, base.weights.execution_doctor_ga),
      operational_maturity: clampNumber(weights.operational_maturity, 0, 1, base.weights.operational_maturity)
    },
    outputs: {
      latest_path: resolvePath(outputs.latest_path, base.outputs.latest_path),
      history_path: resolvePath(outputs.history_path, base.outputs.history_path),
      freeze_state_path: resolvePath(outputs.freeze_state_path, base.outputs.freeze_state_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function signalExecutionReliability(filePath: string) {
  const payload = readJson(filePath, null);
  const row = payload && payload.payload && typeof payload.payload === 'object' ? payload.payload : payload;
  if (!row || typeof row !== 'object') {
    return { available: false, pass: false, penalty: 1, reason: 'missing' };
  }
  const pass = row.pass === true || String(row.result || '').toLowerCase() === 'pass';
  return {
    available: true,
    pass,
    penalty: pass ? 0 : 1,
    reason: pass ? 'ok' : 'execution_reliability_regressed'
  };
}

function signalChaos(filePath: string) {
  const payload = readJson(filePath, null);
  if (!payload || typeof payload !== 'object') {
    return { available: false, pass: false, penalty: 1, reason: 'missing', hard_block: false };
  }
  const evalRow = payload.evaluation && typeof payload.evaluation === 'object'
    ? payload.evaluation
    : payload.gate && typeof payload.gate === 'object'
      ? payload.gate
      : {};
  const promotionBlocked = evalRow.promotion_blocked === true;
  const pass = payload.ok === true && !promotionBlocked;
  return {
    available: true,
    pass,
    penalty: pass ? 0 : 1,
    reason: pass ? 'ok' : (promotionBlocked ? 'chaos_gate_blocked' : 'chaos_status_failed'),
    hard_block: promotionBlocked
  };
}

function signalSimpleOk(filePath: string, reasonKey: string) {
  const payload = readJson(filePath, null);
  if (!payload || typeof payload !== 'object') {
    return { available: false, pass: false, penalty: 1, reason: 'missing' };
  }
  const pass = payload.ok === true || payload.pass === true || String(payload.result || '').toLowerCase() === 'pass';
  return {
    available: true,
    pass,
    penalty: pass ? 0 : 1,
    reason: pass ? 'ok' : reasonKey
  };
}

function evaluate(policy: AnyObj) {
  const signals = {
    execution_reliability: signalExecutionReliability(policy.sources.execution_reliability_path),
    chaos_resilience: signalChaos(policy.sources.continuous_chaos_latest_path),
    execution_doctor_ga: signalSimpleOk(policy.sources.execution_doctor_latest_path, 'execution_doctor_ga_regressed'),
    operational_maturity: signalSimpleOk(policy.sources.operational_maturity_latest_path, 'operational_maturity_regressed')
  };

  const reasons: string[] = [];
  let weightedPenalty = 0;
  let totalWeight = 0;

  for (const key of Object.keys(signals)) {
    const signal = (signals as AnyObj)[key];
    const weight = Number((policy.weights && policy.weights[key]) || 0);
    if (!(weight > 0)) continue;
    totalWeight += weight;
    if (signal.available !== true && policy.budget.missing_signal_penalty !== true) {
      continue;
    }
    const penalty = Number(signal.penalty || 0);
    weightedPenalty += weight * penalty;
    if (signal.available !== true) {
      reasons.push(`missing_signal:${key}`);
    } else if (signal.pass !== true) {
      reasons.push(`signal_failed:${key}:${cleanText(signal.reason || 'failed', 80)}`);
    }
    if (signal.hard_block === true) reasons.push(`hard_block:${key}`);
  }

  const burnRatio = totalWeight > 0
    ? Number((weightedPenalty / totalWeight).toFixed(4))
    : 0;
  const overBudget = burnRatio > Number(policy.budget.max_burn_ratio || 0);
  const warn = burnRatio > Number(policy.budget.warn_burn_ratio || 0);
  if (overBudget) reasons.push('error_budget_exceeded');
  if (warn) reasons.push('error_budget_warn');
  const promotionBlocked = overBudget || reasons.some((r) => r.startsWith('hard_block:'));

  return {
    ok: !promotionBlocked,
    burn_ratio: burnRatio,
    weighted_penalty: Number(weightedPenalty.toFixed(4)),
    total_weight: Number(totalWeight.toFixed(4)),
    promotion_blocked: promotionBlocked,
    warn,
    reasons: Array.from(new Set(reasons)),
    signals
  };
}

function writeOutputs(policy: AnyObj, payload: AnyObj) {
  writeJsonAtomic(policy.outputs.latest_path, payload);
  appendJsonl(policy.outputs.history_path, payload);
  writeJsonAtomic(policy.outputs.freeze_state_path, {
    type: 'error_budget_release_freeze_state',
    ts: payload.ts,
    frozen: payload.gate && payload.gate.promotion_blocked === true,
    burn_ratio: payload.gate ? payload.gate.burn_ratio : null,
    reasons: payload.gate && Array.isArray(payload.gate.reasons) ? payload.gate.reasons : []
  });
}

function cmdGate(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  if (policy.enabled !== true) {
    const out = {
      ok: false,
      type: 'error_budget_release_gate',
      ts: nowIso(),
      error: 'policy_disabled',
      policy_path: rel(policy.policy_path)
    };
    process.stdout.write(`${JSON.stringify(out)}\n`);
    process.exit(1);
  }
  const strict = toBool(args.strict, policy.strict_default);
  const gate = evaluate(policy);
  const out = {
    ok: gate.ok === true,
    type: 'error_budget_release_gate',
    ts: nowIso(),
    strict,
    shadow_only: policy.shadow_only === true,
    policy_path: rel(policy.policy_path),
    sources: {
      execution_reliability_path: rel(policy.sources.execution_reliability_path),
      continuous_chaos_latest_path: rel(policy.sources.continuous_chaos_latest_path),
      execution_doctor_latest_path: rel(policy.sources.execution_doctor_latest_path),
      operational_maturity_latest_path: rel(policy.sources.operational_maturity_latest_path)
    },
    gate
  };
  writeOutputs(policy, out);
  process.stdout.write(`${JSON.stringify(out)}\n`);
  if (strict && out.ok !== true) process.exit(1);
}

function cmdStatus(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const latest = readJson(policy.outputs.latest_path, null);
  if (!latest || typeof latest !== 'object') {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      type: 'error_budget_release_gate_status',
      error: 'latest_missing',
      latest_path: rel(policy.outputs.latest_path),
      policy_path: rel(policy.policy_path)
    })}\n`);
    process.exit(1);
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'error_budget_release_gate_status',
    ts: nowIso(),
    policy_path: rel(policy.policy_path),
    latest_path: rel(policy.outputs.latest_path),
    payload: latest
  })}\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = cleanText(args._[0] || '', 80).toLowerCase();
  if (!cmd || cmd === 'help' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'gate' || cmd === 'run') return cmdGate(args);
  if (cmd === 'status') return cmdStatus(args);
  usage();
  process.exit(2);
}

if (require.main === module) {
  main();
}

module.exports = {
  DEFAULT_POLICY_PATH,
  loadPolicy,
  evaluate
};
