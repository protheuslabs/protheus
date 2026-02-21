#!/usr/bin/env node
'use strict';

/**
 * systems/spawn/spawn_broker.js
 *
 * Centralized spawn capacity broker for module cell pools.
 *
 * Goals:
 * - Keep module spawn requests inside global hardware + quota budgets.
 * - Provide deterministic request/grant/release behavior across modules.
 * - Reuse router hardware-plan so spawn budgets follow current machine limits.
 *
 * Usage:
 *   node systems/spawn/spawn_broker.js status [--module=reflex]
 *   node systems/spawn/spawn_broker.js request --module=reflex --requested_cells=2 [--reason=...] [--apply=1]
 *   node systems/spawn/spawn_broker.js release --module=reflex [--reason=...]
 *   node systems/spawn/spawn_broker.js --help
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  loadSystemBudgetState,
  saveSystemBudgetState,
  projectSystemBudget,
  recordSystemBudgetUsage
} = require('../budget/system_budget.js');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const POLICY_PATH = process.env.SPAWN_POLICY_PATH
  ? path.resolve(process.env.SPAWN_POLICY_PATH)
  : path.join(REPO_ROOT, 'config', 'spawn_policy.json');
const STATE_DIR = process.env.SPAWN_STATE_DIR
  ? path.resolve(process.env.SPAWN_STATE_DIR)
  : path.join(REPO_ROOT, 'state', 'spawn');
const STATE_PATH = path.join(STATE_DIR, 'allocations.json');
const EVENTS_PATH = path.join(STATE_DIR, 'events.jsonl');
const TOKEN_BUDGET_DIR = process.env.SPAWN_TOKEN_BUDGET_DIR
  ? path.resolve(process.env.SPAWN_TOKEN_BUDGET_DIR)
  : path.join(STATE_DIR, 'token_budget');
const ROUTER_SCRIPT = process.env.SPAWN_ROUTER_SCRIPT
  ? path.resolve(process.env.SPAWN_ROUTER_SCRIPT)
  : path.join(REPO_ROOT, 'systems', 'routing', 'model_router.js');

function nowIso() {
  return new Date().toISOString();
}

function clampNumber(v, lo, hi, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function toBool(v, fallback = false) {
  if (v == null) return fallback;
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  return fallback;
}

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function readJson(p, fallback) {
  try {
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(p, obj) {
  ensureDir(path.dirname(p));
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, p);
}

function appendJsonl(p, obj) {
  ensureDir(path.dirname(p));
  fs.appendFileSync(p, `${JSON.stringify(obj)}\n`, 'utf8');
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
  console.log('  node systems/spawn/spawn_broker.js status [--module=reflex]');
  console.log('  node systems/spawn/spawn_broker.js request --module=name --requested_cells=N [--request_tokens_est=N] [--reason=...] [--apply=1]');
  console.log('  node systems/spawn/spawn_broker.js release --module=name [--reason=...]');
  console.log('  node systems/spawn/spawn_broker.js --help');
}

function safeJson(stdout) {
  const txt = String(stdout || '').trim();
  if (!txt) return null;
  try {
    return JSON.parse(txt);
  } catch {
    const lines = txt.split('\n').reverse();
    for (const line of lines) {
      const s = String(line || '').trim();
      if (!s.startsWith('{')) continue;
      try {
        return JSON.parse(s);
      } catch {}
    }
    return null;
  }
}

function normalizeClass(v) {
  return String(v || '').trim().toLowerCase();
}

function normalizeModuleName(v) {
  const name = String(v || 'reflex').trim().toLowerCase();
  return name || 'reflex';
}

function parseQuotaModules(rawModules, defaultMax) {
  if (!rawModules || typeof rawModules !== 'object') return {};
  const out = {};
  for (const [name, cfg] of Object.entries(rawModules)) {
    const maxCells = clampNumber(cfg && cfg.max_cells, 0, 512, defaultMax);
    out[String(name)] = { max_cells: Math.round(maxCells) };
  }
  return out;
}

function parseTokenBudgetModules(rawModules, defaultDailyCap, defaultPerRequestCap) {
  if (!rawModules || typeof rawModules !== 'object') return {};
  const out = {};
  for (const [name, cfg] of Object.entries(rawModules)) {
    out[String(name)] = {
      daily_token_cap: Math.round(clampNumber(cfg && cfg.daily_token_cap, 0, 100000000, defaultDailyCap)),
      per_request_token_cap: Math.round(clampNumber(cfg && cfg.per_request_token_cap, 0, 10000000, defaultPerRequestCap))
    };
  }
  return out;
}

function loadPolicy() {
  const raw = readJson(POLICY_PATH, {}) || {};
  const pool = raw.pool && typeof raw.pool === 'object' ? raw.pool : {};
  const quotas = raw.quotas && typeof raw.quotas === 'object' ? raw.quotas : {};
  const leases = raw.leases && typeof raw.leases === 'object' ? raw.leases : {};
  const tokenBudget = raw.token_budget && typeof raw.token_budget === 'object' ? raw.token_budget : {};

  const minCells = Math.max(0, Math.round(Number(pool.min_cells || 0)));
  const maxCells = Math.max(minCells, Math.round(Number(pool.max_cells || 6)));
  const defaultQuota = Math.max(0, Math.round(Number(quotas.default_max_cells || 2)));

  return {
    version: String(raw.version || '1.0'),
    pool: {
      min_cells: minCells,
      max_cells: maxCells,
      reserve_cpu_threads: clampNumber(pool.reserve_cpu_threads, 0, 256, 2),
      reserve_ram_gb: clampNumber(pool.reserve_ram_gb, 0, 512, 4),
      estimated_cpu_threads_per_cell: clampNumber(pool.estimated_cpu_threads_per_cell, 0.1, 128, 1),
      estimated_ram_gb_per_cell: clampNumber(pool.estimated_ram_gb_per_cell, 0.1, 512, 1.2),
      max_cells_by_hardware: pool.max_cells_by_hardware && typeof pool.max_cells_by_hardware === 'object'
        ? pool.max_cells_by_hardware
        : {
            tiny: 1,
            small: 2,
            medium: 3,
            large: 4,
            xlarge: maxCells
          }
    },
    quotas: {
      default_max_cells: defaultQuota,
      modules: parseQuotaModules(quotas.modules, defaultQuota)
    },
    token_budget: {
      enabled: toBool(tokenBudget.enabled, false),
      default_daily_token_cap: Math.round(clampNumber(tokenBudget.default_daily_token_cap, 0, 100000000, 0)),
      default_per_request_token_cap: Math.round(clampNumber(tokenBudget.default_per_request_token_cap, 0, 10000000, 0)),
      soft_ratio: clampNumber(tokenBudget.soft_ratio, 0.5, 0.99, 0.8),
      hard_ratio: clampNumber(tokenBudget.hard_ratio, 0.6, 1, 0.95),
      modules: parseTokenBudgetModules(
        tokenBudget.modules,
        Math.round(clampNumber(tokenBudget.default_daily_token_cap, 0, 100000000, 0)),
        Math.round(clampNumber(tokenBudget.default_per_request_token_cap, 0, 10000000, 0))
      )
    },
    leases: {
      enabled: leases.enabled !== false,
      default_ttl_sec: Math.round(clampNumber(leases.default_ttl_sec, 30, 86400, 300)),
      max_ttl_sec: Math.round(clampNumber(leases.max_ttl_sec, 60, 172800, 3600))
    }
  };
}

function budgetDateStr() {
  return nowIso().slice(0, 10);
}

function tokenBudgetStatePathForDate(day) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(day || '')) ? String(day) : budgetDateStr();
  return path.join(TOKEN_BUDGET_DIR, `${date}.json`);
}

function loadTokenBudgetState(day) {
  const state = loadSystemBudgetState(day, {
    state_dir: TOKEN_BUDGET_DIR
  });
  return {
    date: String(state.date || budgetDateStr()),
    token_cap: Number.isFinite(Number(state.token_cap)) ? Number(state.token_cap) : null,
    used_est: Number.isFinite(Number(state.used_est)) ? Number(state.used_est) : 0,
    by_module: state.by_module && typeof state.by_module === 'object' ? state.by_module : {}
  };
}

function saveTokenBudgetState(state) {
  saveSystemBudgetState({
    ...(state && typeof state === 'object' ? state : {}),
    date: state && state.date ? String(state.date) : budgetDateStr()
  }, {
    state_dir: TOKEN_BUDGET_DIR,
    allow_strategy: false
  });
}

function moduleTokenCaps(policy, moduleName) {
  const defaults = policy && policy.token_budget ? policy.token_budget : {};
  const modules = defaults.modules && typeof defaults.modules === 'object' ? defaults.modules : {};
  const moduleCfg = modules[moduleName] && typeof modules[moduleName] === 'object' ? modules[moduleName] : {};
  return {
    daily_token_cap: Math.max(0, Number(moduleCfg.daily_token_cap != null ? moduleCfg.daily_token_cap : defaults.default_daily_token_cap || 0)),
    per_request_token_cap: Math.max(0, Number(moduleCfg.per_request_token_cap != null ? moduleCfg.per_request_token_cap : defaults.default_per_request_token_cap || 0))
  };
}

function parseRequestedTokens(args) {
  const raw = args.request_tokens_est != null
    ? args.request_tokens_est
    : (args.token_cost_est != null ? args.token_cost_est : args.token_cost);
  const n = Number(raw || 0);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.max(0, Math.round(n));
}

function evaluateTokenBudget(policy, state, moduleName, requestedTokens, requestedCells) {
  const tokenPolicy = policy && policy.token_budget ? policy.token_budget : { enabled: false };
  const caps = moduleTokenCaps(policy, moduleName);
  const moduleUsed = state.by_module && state.by_module[moduleName] && typeof state.by_module[moduleName] === 'object'
    ? Number(state.by_module[moduleName].used_est || 0)
    : 0;
  const used = Number(state.used_est || 0);
  const projectedModule = moduleUsed + requestedTokens;
  const projectedGlobal = used + requestedTokens;
  const moduleCap = Number(caps.daily_token_cap || 0);
  const perRequestCap = Number(caps.per_request_token_cap || 0);

  const projection = projectSystemBudget(state, requestedTokens, {
    soft_ratio: tokenPolicy.soft_ratio,
    hard_ratio: tokenPolicy.hard_ratio
  });

  const out = {
    enabled: tokenPolicy.enabled === true,
    date: String(state.date || budgetDateStr()),
    requested_tokens_est: requestedTokens,
    used_est: used,
    module_used_est: moduleUsed,
    projected_used_est: projectedGlobal,
    projected_module_used_est: projectedModule,
    module_daily_token_cap: moduleCap,
    per_request_token_cap: perRequestCap,
    pressure: 'none',
    action: 'none',
    allow: true,
    reason: null,
    suggested_cells: requestedCells,
    global_token_cap: Number.isFinite(Number(state.token_cap)) ? Number(state.token_cap) : null,
    projected_global_ratio: projection.projected_ratio,
    projected_global_pressure: projection.projected_pressure
  };

  if (!out.enabled || requestedTokens <= 0) return out;

  if (perRequestCap > 0 && requestedTokens > perRequestCap) {
    out.allow = false;
    out.action = 'escalate';
    out.reason = 'per_request_token_cap_exceeded';
    out.suggested_cells = 0;
    return out;
  }

  if (moduleCap > 0) {
    const ratio = projectedModule / moduleCap;
    if (ratio >= Number(tokenPolicy.hard_ratio || 0.95)) out.pressure = 'hard';
    else if (ratio >= Number(tokenPolicy.soft_ratio || 0.8)) out.pressure = 'soft';
  }

  if (moduleCap > 0 && projectedModule > moduleCap) {
    out.allow = false;
    out.action = 'escalate';
    out.reason = 'module_daily_token_cap_exceeded';
    out.suggested_cells = 0;
    return out;
  }

  if (projection.projected_pressure === 'hard') {
    out.action = 'degrade';
    out.reason = 'hard_global_budget_pressure';
    out.suggested_cells = Math.max(0, Math.min(requestedCells, 1));
  } else if (projection.projected_pressure === 'soft' && requestedCells > 1) {
    out.action = 'degrade';
    out.reason = 'soft_global_budget_pressure';
    out.suggested_cells = Math.max(1, requestedCells - 1);
  }

  if (out.pressure === 'hard') {
    out.action = 'degrade';
    out.reason = 'hard_budget_pressure';
    out.suggested_cells = Math.max(0, Math.min(requestedCells, 1));
  } else if (out.pressure === 'soft' && requestedCells > 1) {
    out.action = 'degrade';
    out.reason = 'soft_budget_pressure';
    out.suggested_cells = Math.max(1, requestedCells - 1);
  }

  return out;
}

function defaultState() {
  return {
    version: 1,
    ts: nowIso(),
    allocations: {}
  };
}

function normalizeAllocation(moduleName, rawEntry) {
  const entry = rawEntry && typeof rawEntry === 'object' ? rawEntry : {};
  const cells = Math.max(0, Math.round(Number(entry.cells || 0)));
  if (cells <= 0) return null;
  return {
    module: moduleName,
    cells,
    ts: String(entry.ts || nowIso()),
    reason: String(entry.reason || ''),
    lease_expires_at: entry.lease_expires_at ? String(entry.lease_expires_at) : null
  };
}

function loadState() {
  const raw = readJson(STATE_PATH, null);
  if (!raw || typeof raw !== 'object') return defaultState();
  const allocations = {};
  const rawAlloc = raw.allocations && typeof raw.allocations === 'object' ? raw.allocations : {};
  for (const [name, ent] of Object.entries(rawAlloc)) {
    const norm = normalizeAllocation(String(name), ent);
    if (norm) allocations[String(name)] = norm;
  }
  return {
    version: 1,
    ts: String(raw.ts || nowIso()),
    allocations
  };
}

function saveState(state) {
  writeJsonAtomic(STATE_PATH, state);
}

function isExpired(isoTs) {
  if (!isoTs) return false;
  const ms = Date.parse(String(isoTs));
  if (!Number.isFinite(ms)) return false;
  return Date.now() > ms;
}

function pruneExpired(state) {
  let changed = false;
  const next = {
    version: 1,
    ts: nowIso(),
    allocations: {}
  };
  for (const [name, ent] of Object.entries(state.allocations || {})) {
    if (isExpired(ent.lease_expires_at)) {
      changed = true;
      continue;
    }
    next.allocations[name] = ent;
  }
  return { state: next, changed };
}

function routerHardwarePlan() {
  const r = spawnSync('node', [ROUTER_SCRIPT, 'hardware-plan'], {
    cwd: REPO_ROOT,
    encoding: 'utf8'
  });
  const payload = safeJson(r.stdout);
  return {
    ok: r.status === 0 && !!payload,
    payload,
    error: String(r.stderr || '').trim().slice(0, 240)
  };
}

function hardwareBounds(policy, planPayload) {
  const pool = policy.pool;
  const p = planPayload && typeof planPayload === 'object' ? planPayload : {};
  const profile = p.profile && typeof p.profile === 'object' ? p.profile : {};
  const hwClass = normalizeClass(profile.hardware_class || '');

  const byClassRaw = pool.max_cells_by_hardware && typeof pool.max_cells_by_hardware === 'object'
    ? pool.max_cells_by_hardware
    : {};
  const classCapRaw = Number(byClassRaw[hwClass]);
  const classCap = Number.isFinite(classCapRaw)
    ? Math.max(pool.min_cells, Math.min(pool.max_cells, Math.round(classCapRaw)))
    : pool.max_cells;

  const cpuThreads = Number(profile.cpu_threads);
  const ramGb = Number(profile.ram_gb);
  const perCellCpu = Number(pool.estimated_cpu_threads_per_cell || 1);
  const perCellRam = Number(pool.estimated_ram_gb_per_cell || 1);
  const cpuHeadroom = Number(pool.reserve_cpu_threads || 0);
  const ramHeadroom = Number(pool.reserve_ram_gb || 0);

  const capByCpu = Number.isFinite(cpuThreads) && perCellCpu > 0
    ? Math.max(0, Math.floor(Math.max(0, cpuThreads - cpuHeadroom) / perCellCpu))
    : pool.max_cells;
  const capByRam = Number.isFinite(ramGb) && perCellRam > 0
    ? Math.max(0, Math.floor(Math.max(0, ramGb - ramHeadroom) / perCellRam))
    : pool.max_cells;

  const globalMax = Math.max(
    pool.min_cells,
    Math.min(pool.max_cells, classCap, capByCpu, capByRam)
  );

  return {
    hardware_class: hwClass || null,
    cpu_threads: Number.isFinite(cpuThreads) ? cpuThreads : null,
    ram_gb: Number.isFinite(ramGb) ? ramGb : null,
    cap_by_class: classCap,
    cap_by_cpu: capByCpu,
    cap_by_ram: capByRam,
    global_max_cells: globalMax
  };
}

function moduleQuotaMax(policy, moduleName, globalMax) {
  const moduleCfg = policy.quotas.modules[moduleName];
  const raw = moduleCfg && typeof moduleCfg === 'object'
    ? moduleCfg.max_cells
    : policy.quotas.default_max_cells;
  const n = Number(raw);
  if (!Number.isFinite(n)) return Math.max(0, globalMax);
  return Math.max(0, Math.min(Math.round(n), globalMax));
}

function cellsFor(state, moduleName) {
  const ent = state.allocations && state.allocations[moduleName];
  return ent ? Math.max(0, Math.round(Number(ent.cells || 0))) : 0;
}

function sumAllocations(state, skipModule) {
  let total = 0;
  for (const [name, ent] of Object.entries(state.allocations || {})) {
    if (skipModule && name === skipModule) continue;
    total += Math.max(0, Math.round(Number(ent.cells || 0)));
  }
  return total;
}

function computeLimits(policy, state, moduleName, bounds) {
  const globalMax = Math.max(0, Math.round(Number(bounds.global_max_cells || 0)));
  const current = cellsFor(state, moduleName);
  const allocatedOther = sumAllocations(state, moduleName);
  const allocatedTotal = allocatedOther + current;
  const freeWithCurrent = Math.max(0, globalMax - allocatedOther);
  const freeGlobal = Math.max(0, globalMax - allocatedTotal);
  const moduleQuota = moduleQuotaMax(policy, moduleName, globalMax);
  const maxCells = Math.max(0, Math.min(moduleQuota, freeWithCurrent));

  return {
    module: moduleName,
    global_max_cells: globalMax,
    module_quota_max_cells: moduleQuota,
    module_current_cells: current,
    allocated_other_cells: allocatedOther,
    allocated_total_cells: allocatedTotal,
    free_global_cells: freeGlobal,
    max_cells: maxCells
  };
}

function summarizeAllocations(state) {
  const out = {};
  for (const [name, ent] of Object.entries(state.allocations || {})) {
    out[name] = {
      cells: Math.max(0, Math.round(Number(ent.cells || 0))),
      ts: String(ent.ts || ''),
      reason: String(ent.reason || ''),
      lease_expires_at: ent.lease_expires_at || null
    };
  }
  return out;
}

function resolveLeaseExpires(policy, args) {
  if (policy.leases.enabled !== true) return null;
  const raw = args.lease_sec != null ? args.lease_sec : args.lease;
  const ttlSec = raw == null
    ? policy.leases.default_ttl_sec
    : Math.round(clampNumber(raw, 5, policy.leases.max_ttl_sec, policy.leases.default_ttl_sec));
  const expiresMs = Date.now() + ttlSec * 1000;
  return new Date(expiresMs).toISOString();
}

function cmdStatus(args) {
  const moduleName = normalizeModuleName(args.module);
  const policy = loadPolicy();
  let state = loadState();
  const pruned = pruneExpired(state);
  state = pruned.state;
  if (pruned.changed) saveState(state);

  const hw = routerHardwarePlan();
  const bounds = hardwareBounds(policy, hw.payload || {});
  const limits = computeLimits(policy, state, moduleName, bounds);
  const tokenBudgetState = loadTokenBudgetState(args.date);
  const tokenBudget = evaluateTokenBudget(policy, tokenBudgetState, moduleName, 0, limits.module_current_cells);

  process.stdout.write(JSON.stringify({
    ok: true,
    ts: nowIso(),
    module: moduleName,
    policy,
    state: {
      version: state.version,
      ts: state.ts,
      allocations: summarizeAllocations(state)
    },
    limits,
    token_budget: tokenBudget,
    hardware_plan_ok: hw.ok,
    hardware_plan_error: hw.ok ? null : hw.error,
    hardware_bounds: bounds
  }, null, 2) + '\n');
}

function cmdRequest(args) {
  const moduleName = normalizeModuleName(args.module);
  const requestedRaw = args.requested_cells != null ? args.requested_cells : args.requested;
  const requestedCells = Math.max(0, Math.round(Number(requestedRaw || 0)));
  const reason = String(args.reason || '').slice(0, 160);
  const apply = String(args.apply || '1') !== '0';
  const requestedTokens = parseRequestedTokens(args);

  const policy = loadPolicy();
  let state = loadState();
  const pruned = pruneExpired(state);
  state = pruned.state;
  if (pruned.changed) saveState(state);

  const hw = routerHardwarePlan();
  const bounds = hardwareBounds(policy, hw.payload || {});
  const limits = computeLimits(policy, state, moduleName, bounds);
  const tokenBudgetState = loadTokenBudgetState(args.date);
  const tokenBudget = evaluateTokenBudget(policy, tokenBudgetState, moduleName, requestedTokens, requestedCells);
  const budgetRequestedCells = tokenBudget.action === 'degrade'
    ? Math.max(0, Math.min(requestedCells, Number(tokenBudget.suggested_cells || requestedCells)))
    : requestedCells;
  const grantedCells = tokenBudget.allow
    ? Math.max(0, Math.min(budgetRequestedCells, limits.max_cells))
    : 0;

  const leaseExpiresAt = resolveLeaseExpires(policy, args);

  if (apply) {
    const allocations = { ...(state.allocations || {}) };
    if (grantedCells <= 0) {
      delete allocations[moduleName];
    } else {
      allocations[moduleName] = {
        module: moduleName,
        cells: grantedCells,
        ts: nowIso(),
        reason,
        lease_expires_at: leaseExpiresAt
      };
    }
    state = {
      version: 1,
      ts: nowIso(),
      allocations
    };
    saveState(state);
    appendJsonl(EVENTS_PATH, {
      ts: nowIso(),
      type: 'spawn_request',
      module: moduleName,
      requested_cells: requestedCells,
      granted_cells: grantedCells,
      requested_tokens_est: requestedTokens,
      reason: reason || null,
      lease_expires_at: leaseExpiresAt,
      limits,
      token_budget: tokenBudget,
      hardware_bounds: bounds
    });

    if (tokenBudget.enabled && requestedTokens > 0 && tokenBudget.allow) {
      recordSystemBudgetUsage({
        date: String(tokenBudgetState.date || budgetDateStr()),
        tokens_est: requestedTokens,
        module: moduleName,
        capability: 'spawn'
      }, {
        state_dir: TOKEN_BUDGET_DIR
      });
    }
  }

  process.stdout.write(JSON.stringify({
    ok: true,
    ts: nowIso(),
    module: moduleName,
    apply,
    requested_cells: requestedCells,
    granted_cells: grantedCells,
    requested_tokens_est: requestedTokens,
    reason: reason || null,
    lease_expires_at: leaseExpiresAt,
    limits,
    token_budget: tokenBudget,
    hardware_plan_ok: hw.ok,
    hardware_plan_error: hw.ok ? null : hw.error,
    hardware_bounds: bounds
  }, null, 2) + '\n');
}

function cmdRelease(args) {
  const moduleName = normalizeModuleName(args.module);
  const reason = String(args.reason || 'release').slice(0, 160);
  let state = loadState();
  const prev = cellsFor(state, moduleName);

  const allocations = { ...(state.allocations || {}) };
  delete allocations[moduleName];
  state = {
    version: 1,
    ts: nowIso(),
    allocations
  };
  saveState(state);

  appendJsonl(EVENTS_PATH, {
    ts: nowIso(),
    type: 'spawn_release',
    module: moduleName,
    previous_cells: prev,
    reason: reason || null
  });

  process.stdout.write(JSON.stringify({
    ok: true,
    ts: nowIso(),
    module: moduleName,
    released_cells: prev,
    reason: reason || null
  }, null, 2) + '\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim();
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'status') return cmdStatus(args);
  if (cmd === 'request') return cmdRequest(args);
  if (cmd === 'release') return cmdRelease(args);
  usage();
  process.exit(2);
}

if (require.main === module) {
  main();
}

module.exports = {
  loadPolicy,
  loadState,
  computeLimits,
  hardwareBounds
};
