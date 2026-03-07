#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

type AnyObj = Record<string, any>;

const ROOT = process.env.GENERATIVE_SIM_ROOT
  ? path.resolve(process.env.GENERATIVE_SIM_ROOT)
  : path.resolve(__dirname, '..', '..');

const DEFAULT_POLICY_PATH = process.env.GENERATIVE_SIM_POLICY_PATH
  ? path.resolve(process.env.GENERATIVE_SIM_POLICY_PATH)
  : path.join(ROOT, 'config', 'generative_simulation_mode_policy.json');

function nowIso() {
  return new Date().toISOString();
}

function cleanText(v: unknown, maxLen = 240) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeToken(v: unknown, maxLen = 120) {
  return cleanText(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.:/-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
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

function toBool(v: unknown, fallback = false) {
  if (v == null) return fallback;
  const raw = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
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
  console.log('  node systems/assimilation/generative_simulation_mode.js run --input-json="{...}" [--policy=<path>] [--apply=1|0]');
  console.log('  node systems/assimilation/generative_simulation_mode.js status [--policy=<path>]');
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
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

function resolvePath(raw: unknown, fallbackRel: string) {
  const txt = cleanText(raw || fallbackRel, 500);
  if (!txt) return path.join(ROOT, fallbackRel);
  return path.isAbsolute(txt) ? txt : path.join(ROOT, txt);
}

function parseJsonArg(raw: unknown, fallback: any = {}) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return fallback;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function seededFloat(seed: string, offset: string) {
  const digest = crypto.createHash('sha256').update(`${seed}|${offset}`, 'utf8').digest('hex').slice(0, 12);
  const n = parseInt(digest, 16);
  return (n % 1000000) / 1000000;
}

function defaultPolicy() {
  return {
    schema_id: 'generative_simulation_mode_policy',
    schema_version: '1.0',
    enabled: true,
    shadow_only: true,
    beta_stage_lock: {
      enabled: true,
      max_allowed_stage: 'months',
      locked_stages: ['years', 'decades', 'centuries']
    },
    scenarios: {
      count: 6,
      fail_if_drift_over: 0.55,
      fail_if_safety_under: 0.45,
      fail_if_yield_under: 0.18
    },
    stage_windows: {
      days: 7,
      weeks: 30,
      months: 120,
      years: 365,
      decades: 3650,
      centuries: 36500
    },
    state: {
      latest_path: 'state/assimilation/generative_simulation/latest.json',
      receipts_path: 'state/assimilation/generative_simulation/receipts.jsonl'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const lock = raw.beta_stage_lock && typeof raw.beta_stage_lock === 'object' ? raw.beta_stage_lock : {};
  const scenarios = raw.scenarios && typeof raw.scenarios === 'object' ? raw.scenarios : {};
  const windows = raw.stage_windows && typeof raw.stage_windows === 'object' ? raw.stage_windows : {};
  const state = raw.state && typeof raw.state === 'object' ? raw.state : {};
  return {
    schema_id: base.schema_id,
    schema_version: cleanText(raw.schema_version || base.schema_version, 24) || base.schema_version,
    enabled: raw.enabled !== false,
    shadow_only: toBool(raw.shadow_only, base.shadow_only),
    beta_stage_lock: {
      enabled: lock.enabled !== false,
      max_allowed_stage: normalizeToken(lock.max_allowed_stage || base.beta_stage_lock.max_allowed_stage, 20)
        || base.beta_stage_lock.max_allowed_stage,
      locked_stages: Array.isArray(lock.locked_stages)
        ? lock.locked_stages.map((v: unknown) => normalizeToken(v, 20)).filter(Boolean)
        : base.beta_stage_lock.locked_stages.slice(0)
    },
    scenarios: {
      count: clampInt(scenarios.count, 1, 32, base.scenarios.count),
      fail_if_drift_over: clampNumber(scenarios.fail_if_drift_over, 0, 1, base.scenarios.fail_if_drift_over),
      fail_if_safety_under: clampNumber(scenarios.fail_if_safety_under, 0, 1, base.scenarios.fail_if_safety_under),
      fail_if_yield_under: clampNumber(scenarios.fail_if_yield_under, 0, 1, base.scenarios.fail_if_yield_under)
    },
    stage_windows: {
      days: clampInt(windows.days, 1, 365000, base.stage_windows.days),
      weeks: clampInt(windows.weeks, 1, 365000, base.stage_windows.weeks),
      months: clampInt(windows.months, 1, 365000, base.stage_windows.months),
      years: clampInt(windows.years, 1, 365000, base.stage_windows.years),
      decades: clampInt(windows.decades, 1, 365000, base.stage_windows.decades),
      centuries: clampInt(windows.centuries, 1, 365000, base.stage_windows.centuries)
    },
    state: {
      latest_path: resolvePath(state.latest_path || base.state.latest_path, base.state.latest_path),
      receipts_path: resolvePath(state.receipts_path || base.state.receipts_path, base.state.receipts_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function chooseStage(input: AnyObj, policy: AnyObj) {
  const impact = clampNumber(input.impact_score, 0, 1, 0.45);
  const risk = normalizeToken(input.risk_class || 'general', 40) || 'general';
  if (impact >= 0.8 || ['identity', 'constitution', 'payments', 'auth'].includes(risk)) return 'months';
  if (impact >= 0.55 || ['filesystem', 'shell', 'network-control'].includes(risk)) return 'weeks';
  return 'days';
}

function stageAllowed(stage: string, policy: AnyObj) {
  const order = ['days', 'weeks', 'months', 'years', 'decades', 'centuries'];
  const idx = order.indexOf(stage);
  const maxIdx = order.indexOf(String(policy.beta_stage_lock.max_allowed_stage || 'months'));
  const lockDenied = Array.isArray(policy.beta_stage_lock.locked_stages)
    && policy.beta_stage_lock.locked_stages.includes(stage);
  if (policy.beta_stage_lock.enabled !== true) return { allowed: true, reason: 'beta_lock_disabled' };
  if (lockDenied) return { allowed: false, reason: 'stage_locked_beta' };
  if (idx > maxIdx) return { allowed: false, reason: 'stage_above_beta_limit' };
  return { allowed: true, reason: 'stage_allowed' };
}

function simulateScenario(seed: string, scenarioId: string, base: AnyObj) {
  const volatility = seededFloat(seed, `${scenarioId}:vol`);
  const adversity = seededFloat(seed, `${scenarioId}:adv`);
  const drift = clampNumber(Number(base.base_drift || 0.22) + (volatility * 0.25) + (adversity * 0.2), 0, 1, 0.22);
  const safety = clampNumber(Number(base.base_safety || 0.78) - (adversity * 0.28), 0, 1, 0.78);
  const yieldRate = clampNumber(Number(base.base_yield || 0.42) - (volatility * 0.2), 0, 1, 0.42);
  return {
    scenario_id: scenarioId,
    drift: Number(drift.toFixed(6)),
    safety: Number(safety.toFixed(6)),
    yield_rate: Number(yieldRate.toFixed(6))
  };
}

function runGenerativeSimulation(inputRaw: AnyObj = {}, opts: AnyObj = {}) {
  const policy = opts.policy && typeof opts.policy === 'object'
    ? opts.policy
    : loadPolicy(opts.policyPath || opts.policy_path || DEFAULT_POLICY_PATH);
  if (policy.enabled !== true) {
    return {
      ok: false,
      type: 'generative_simulation_mode',
      error: 'policy_disabled'
    };
  }

  const ts = nowIso();
  const apply = toBool(opts.apply, false);
  const capabilityId = normalizeToken(inputRaw.capability_id || '', 160) || 'unknown_capability';
  const stage = chooseStage(inputRaw, policy);
  const lock = stageAllowed(stage, policy);

  const heroicClear = !(inputRaw.heroic_echo_blocked === true);
  const constitutionClear = !(inputRaw.constitution_blocked === true);
  const baseSeed = `${capabilityId}|${stage}|${cleanText(inputRaw.objective_id || '', 120)}`;

  const scenarioPool = [
    'baseline',
    'load_spike',
    'adversarial_prompt',
    'long_horizon_drift',
    'policy_shift',
    'api_schema_change',
    'counterparty_failure',
    'latency_regression'
  ];
  const selectedScenarioIds = scenarioPool.slice(0, policy.scenarios.count);
  const base = {
    base_drift: clampNumber(inputRaw.base_drift, 0, 1, 0.22),
    base_safety: clampNumber(inputRaw.base_safety, 0, 1, 0.78),
    base_yield: clampNumber(inputRaw.base_yield, 0, 1, 0.42)
  };
  const scenarios = selectedScenarioIds.map((scenarioId) => simulateScenario(baseSeed, scenarioId, base));

  const avg = (key: string) => {
    if (!scenarios.length) return 0;
    return Number((scenarios.reduce((acc, row) => acc + Number(row[key] || 0), 0) / scenarios.length).toFixed(6));
  };

  const aggregate = {
    avg_drift: avg('drift'),
    avg_safety: avg('safety'),
    avg_yield_rate: avg('yield_rate')
  };

  const fails = [];
  if (aggregate.avg_drift > Number(policy.scenarios.fail_if_drift_over || 0.55)) fails.push('drift_over_threshold');
  if (aggregate.avg_safety < Number(policy.scenarios.fail_if_safety_under || 0.45)) fails.push('safety_under_threshold');
  if (aggregate.avg_yield_rate < Number(policy.scenarios.fail_if_yield_under || 0.18)) fails.push('yield_under_threshold');
  if (!heroicClear) fails.push('heroic_echo_gate_blocked');
  if (!constitutionClear) fails.push('constitution_gate_blocked');
  if (!lock.allowed) fails.push(lock.reason || 'stage_lock_blocked');

  const verdict = fails.length ? 'fail' : 'pass';

  const out = {
    ok: true,
    type: 'generative_simulation_mode',
    ts,
    shadow_only: policy.shadow_only === true,
    apply_requested: apply,
    capability_id: capabilityId,
    stage,
    stage_window_days: Number(policy.stage_windows[stage] || policy.stage_windows.days || 7),
    beta_stage_lock: {
      enabled: policy.beta_stage_lock.enabled === true,
      allowed: lock.allowed,
      reason: lock.reason
    },
    scenarios,
    aggregate,
    heroic_echo_clear: heroicClear,
    constitution_clear: constitutionClear,
    verdict,
    reason_codes: fails,
    policy: {
      path: rel(policy.policy_path || DEFAULT_POLICY_PATH),
      version: policy.schema_version
    }
  };

  writeJsonAtomic(policy.state.latest_path, out);
  appendJsonl(policy.state.receipts_path, out);
  return out;
}

function status(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  return {
    ok: true,
    type: 'generative_simulation_status',
    latest: readJson(policy.state.latest_path, null)
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || 'run', 32) || 'run';
  try {
    if (cmd === 'status') {
      process.stdout.write(`${JSON.stringify(status(args))}\n`);
      return;
    }
    if (cmd === 'run') {
      const input = parseJsonArg(args['input-json'] || args.input_json || '{}', {});
      const out = runGenerativeSimulation(input, {
        policyPath: args.policy,
        apply: args.apply
      });
      process.stdout.write(`${JSON.stringify(out)}\n`);
      process.exit(out && out.ok === true ? 0 : 1);
      return;
    }
    if (cmd === 'help') {
      usage();
      return;
    }
    throw new Error(`unknown_command:${cmd}`);
  } catch (err) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      type: 'generative_simulation_mode',
      error: cleanText(err && (err as AnyObj).message ? (err as AnyObj).message : err || 'generative_simulation_failed', 220)
    })}\n`);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = {
  loadPolicy,
  runGenerativeSimulation
};
