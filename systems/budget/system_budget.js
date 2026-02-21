#!/usr/bin/env node
'use strict';

/**
 * systems/budget/system_budget.js
 *
 * Split-budget contract:
 * - Strategy allocates caps (via active strategy budget_policy).
 * - System enforces caps and pressure.
 * - State records usage in one deterministic ledger.
 *
 * Usage:
 *   node systems/budget/system_budget.js status [YYYY-MM-DD]
 *   node systems/budget/system_budget.js project [YYYY-MM-DD] --request_tokens_est=N
 *   node systems/budget/system_budget.js record [YYYY-MM-DD] --tokens_est=N [--module=name] [--capability=name]
 *   node systems/budget/system_budget.js --help
 */

const fs = require('fs');
const path = require('path');
const { loadActiveStrategy, strategyBudgetCaps } = require('../../lib/strategy_resolver.js');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_STATE_DIR = process.env.SYSTEM_BUDGET_STATE_DIR
  ? path.resolve(process.env.SYSTEM_BUDGET_STATE_DIR)
  : path.join(REPO_ROOT, 'state', 'autonomy', 'daily_budget');
const DEFAULT_EVENTS_PATH = process.env.SYSTEM_BUDGET_EVENTS_PATH
  ? path.resolve(process.env.SYSTEM_BUDGET_EVENTS_PATH)
  : path.join(REPO_ROOT, 'state', 'autonomy', 'budget_events.jsonl');

function nowIso() {
  return new Date().toISOString();
}

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function clamp(v, lo, hi, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function toPositiveInt(v, fallback = 0) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(0, Math.round(n));
}

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath, payload) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function appendJsonl(filePath, payload) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`, 'utf8');
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

function usage() {
  console.log('Usage:');
  console.log('  node systems/budget/system_budget.js status [YYYY-MM-DD]');
  console.log('  node systems/budget/system_budget.js project [YYYY-MM-DD] --request_tokens_est=N');
  console.log('  node systems/budget/system_budget.js record [YYYY-MM-DD] --tokens_est=N [--module=name] [--capability=name]');
  console.log('  node systems/budget/system_budget.js --help');
}

function normalizeDate(v) {
  const raw = String(v || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  return nowIso().slice(0, 10);
}

function resolveStateDir(opts = {}) {
  const raw = String(opts.state_dir || DEFAULT_STATE_DIR);
  return path.isAbsolute(raw) ? raw : path.resolve(REPO_ROOT, raw);
}

function dailyPath(dateStr, opts = {}) {
  return path.join(resolveStateDir(opts), `${normalizeDate(dateStr)}.json`);
}

function normalizeByModule(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  for (const [name, ent] of Object.entries(src)) {
    const key = String(name || '').trim();
    if (!key) continue;
    const used = Number(ent && ent.used_est);
    out[key] = {
      used_est: Number.isFinite(used) && used >= 0 ? used : 0
    };
  }
  return out;
}

function effectiveStrategyBudget(opts = {}) {
  const defaults = {
    daily_token_cap: toPositiveInt(
      opts.daily_token_cap != null ? opts.daily_token_cap : process.env.SYSTEM_BUDGET_DEFAULT_DAILY_TOKEN_CAP,
      4000
    ),
    max_tokens_per_action: toPositiveInt(
      opts.max_tokens_per_action != null ? opts.max_tokens_per_action : process.env.SYSTEM_BUDGET_DEFAULT_MAX_TOKENS_PER_ACTION,
      1600
    ),
    token_cost_per_1k: Number(opts.token_cost_per_1k != null ? opts.token_cost_per_1k : process.env.SYSTEM_BUDGET_DEFAULT_TOKEN_COST_PER_1K || 0),
    daily_usd_cap: Number(opts.daily_usd_cap != null ? opts.daily_usd_cap : process.env.SYSTEM_BUDGET_DEFAULT_DAILY_USD_CAP || 0),
    per_action_avg_usd_cap: Number(opts.per_action_avg_usd_cap != null ? opts.per_action_avg_usd_cap : process.env.SYSTEM_BUDGET_DEFAULT_PER_ACTION_AVG_USD_CAP || 0),
    monthly_usd_allocation: Number(opts.monthly_usd_allocation != null ? opts.monthly_usd_allocation : process.env.SYSTEM_BUDGET_DEFAULT_MONTHLY_USD_ALLOCATION || 0),
    monthly_credits_floor_pct: Number(opts.monthly_credits_floor_pct != null ? opts.monthly_credits_floor_pct : process.env.SYSTEM_BUDGET_DEFAULT_MONTHLY_CREDITS_FLOOR_PCT || 0.2),
    min_projected_tokens_for_burn_check: toPositiveInt(
      opts.min_projected_tokens_for_burn_check != null
        ? opts.min_projected_tokens_for_burn_check
        : process.env.SYSTEM_BUDGET_DEFAULT_MIN_PROJECTED_TOKENS_FOR_BURN_CHECK,
      800
    )
  };
  if (opts.allow_strategy === false) {
    return { caps: strategyBudgetCaps(null, defaults), strategy_id: null };
  }
  let strategy = null;
  try {
    strategy = loadActiveStrategy({
      allowMissing: true,
      strict: false,
      id: opts.strategy_id ? String(opts.strategy_id) : undefined
    });
  } catch {
    strategy = null;
  }
  return {
    caps: strategyBudgetCaps(strategy, defaults),
    strategy_id: strategy ? String(strategy.id || '') || null : null
  };
}

function loadSystemBudgetState(dateStr, opts = {}) {
  const day = normalizeDate(dateStr);
  const fp = dailyPath(day, opts);
  const raw = readJson(fp, {}) || {};
  const strategy = effectiveStrategyBudget(opts);
  const enforcedCap = toPositiveInt(strategy.caps.daily_token_cap, toPositiveInt(raw.token_cap, 0));
  return {
    date: day,
    token_cap: enforcedCap,
    used_est: Number.isFinite(Number(raw.used_est)) && Number(raw.used_est) >= 0 ? Number(raw.used_est) : 0,
    by_module: normalizeByModule(raw.by_module),
    updated_at: raw.updated_at ? String(raw.updated_at) : null,
    strategy_id: strategy.strategy_id || null,
    strategy_budget: strategy.caps,
    path: fp,
    available: true
  };
}

function saveSystemBudgetState(state, opts = {}) {
  const day = normalizeDate(state && state.date);
  const fp = dailyPath(day, opts);
  const previous = readJson(fp, {}) || {};
  const merged = {
    ...previous,
    ...(state && typeof state === 'object' ? state : {}),
    date: day,
    token_cap: toPositiveInt(state && state.token_cap, toPositiveInt(previous.token_cap, 0)),
    used_est: Number.isFinite(Number(state && state.used_est)) && Number(state.used_est) >= 0
      ? Number(state.used_est)
      : (Number.isFinite(Number(previous.used_est)) && Number(previous.used_est) >= 0 ? Number(previous.used_est) : 0),
    by_module: normalizeByModule(state && state.by_module ? state.by_module : previous.by_module),
    updated_at: nowIso()
  };
  writeJsonAtomic(fp, merged);
  return merged;
}

function projectSystemBudget(state, requestTokens, opts = {}) {
  const safeRequest = toPositiveInt(requestTokens, 0);
  const cap = Number(state && state.token_cap);
  const used = Number(state && state.used_est);
  const softRatio = clamp(opts.soft_ratio, 0.2, 0.99, 0.75);
  const hardRatio = clamp(opts.hard_ratio, 0.3, 1, 0.92);
  if (!Number.isFinite(cap) || cap <= 0 || !Number.isFinite(used) || used < 0) {
    return {
      request_tokens_est: safeRequest,
      projected_used_est: null,
      projected_ratio: null,
      pressure: 'none',
      projected_pressure: 'none'
    };
  }
  const ratio = used / cap;
  const projectedUsed = used + safeRequest;
  const projectedRatio = projectedUsed / cap;
  let pressure = 'none';
  if (ratio >= hardRatio) pressure = 'hard';
  else if (ratio >= softRatio) pressure = 'soft';
  let projectedPressure = 'none';
  if (projectedRatio >= hardRatio) projectedPressure = 'hard';
  else if (projectedRatio >= softRatio) projectedPressure = 'soft';
  return {
    request_tokens_est: safeRequest,
    projected_used_est: projectedUsed,
    projected_ratio: Number(projectedRatio.toFixed(4)),
    pressure,
    projected_pressure: projectedPressure
  };
}

function recordSystemBudgetUsage(input, opts = {}) {
  const date = normalizeDate(input && input.date);
  const moduleName = String(input && input.module || 'unknown').trim() || 'unknown';
  const capability = String(input && input.capability || '').trim() || null;
  const tokens = toPositiveInt(input && (input.tokens_est != null ? input.tokens_est : input.tokens), 0);
  const state = loadSystemBudgetState(date, opts);
  if (tokens <= 0) return state;
  const byModule = { ...(state.by_module || {}) };
  const prevModule = byModule[moduleName] && typeof byModule[moduleName] === 'object'
    ? byModule[moduleName]
    : { used_est: 0 };
  byModule[moduleName] = {
    ...prevModule,
    used_est: Number(prevModule.used_est || 0) + tokens
  };
  const next = saveSystemBudgetState({
    ...state,
    used_est: Number(state.used_est || 0) + tokens,
    by_module: byModule
  }, opts);
  appendJsonl(opts.events_path ? path.resolve(String(opts.events_path)) : DEFAULT_EVENTS_PATH, {
    ts: nowIso(),
    type: 'system_budget_record',
    date,
    module: moduleName,
    capability,
    tokens_est: tokens,
    used_est_after: next.used_est,
    token_cap: next.token_cap,
    strategy_id: next.strategy_id || null
  });
  return next;
}

function cmdStatus(args) {
  const date = normalizeDate(args._[1]);
  const state = loadSystemBudgetState(date, { state_dir: args['state-dir'] || args.state_dir });
  const requestTokens = toPositiveInt(args.request_tokens_est, 0);
  const projection = projectSystemBudget(state, requestTokens, {
    soft_ratio: args.soft_ratio,
    hard_ratio: args.hard_ratio
  });
  process.stdout.write(JSON.stringify({
    ok: true,
    ts: nowIso(),
    state,
    projection
  }, null, 2) + '\n');
}

function cmdProject(args) {
  const date = normalizeDate(args._[1]);
  const requestTokens = toPositiveInt(args.request_tokens_est, 0);
  const state = loadSystemBudgetState(date, { state_dir: args['state-dir'] || args.state_dir });
  const projection = projectSystemBudget(state, requestTokens, {
    soft_ratio: args.soft_ratio,
    hard_ratio: args.hard_ratio
  });
  process.stdout.write(JSON.stringify({
    ok: true,
    ts: nowIso(),
    date,
    request_tokens_est: requestTokens,
    ...projection,
    token_cap: state.token_cap,
    used_est: state.used_est
  }, null, 2) + '\n');
}

function cmdRecord(args) {
  const date = normalizeDate(args._[1]);
  const tokens = toPositiveInt(args.tokens_est != null ? args.tokens_est : args.request_tokens_est, 0);
  const moduleName = String(args.module || 'unknown').trim() || 'unknown';
  const capability = String(args.capability || '').trim() || null;
  const next = recordSystemBudgetUsage({
    date,
    tokens_est: tokens,
    module: moduleName,
    capability
  }, {
    state_dir: args['state-dir'] || args.state_dir,
    events_path: args['events-path'] || args.events_path
  });
  process.stdout.write(JSON.stringify({
    ok: true,
    ts: nowIso(),
    date,
    module: moduleName,
    capability,
    tokens_est: tokens,
    used_est_after: next.used_est,
    token_cap: next.token_cap
  }, null, 2) + '\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim().toLowerCase();
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'status') return cmdStatus(args);
  if (cmd === 'project') return cmdProject(args);
  if (cmd === 'record') return cmdRecord(args);
  usage();
  process.exit(2);
}

if (require.main === module) {
  main();
}

module.exports = {
  effectiveStrategyBudget,
  loadSystemBudgetState,
  saveSystemBudgetState,
  projectSystemBudget,
  recordSystemBudgetUsage,
  normalizeDate
};

