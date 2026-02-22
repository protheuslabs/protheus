#!/usr/bin/env node
'use strict';
export {};

/**
 * systems/reflex/reflex_dispatcher.js
 *
 * Dynamic reflex cell-pool controller with centralized spawn-broker allocation.
 *
 * Goals:
 * - Keep reflex cheap/fast for tiny low-risk tasks.
 * - Scale cell count by demand, but allocation is granted by spawn broker.
 * - Avoid rapid oscillation via cooldown + step limits.
 *
 * Usage:
 *   node systems/reflex/reflex_dispatcher.js status
 *   node systems/reflex/reflex_dispatcher.js plan --demand=4 [--headroom=0.8] [--apply=1]
 *   node systems/reflex/reflex_dispatcher.js run --task="..." [--intent=..] [--tokens_est=N] [--demand=N] [--headroom=0.8]
 *   node systems/reflex/reflex_dispatcher.js --help
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { stableUid, randomUid, isAlnum } = require('../../lib/uid.js');

type AnyObj = Record<string, any>;

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const POLICY_PATH = process.env.REFLEX_POLICY_PATH
  ? path.resolve(process.env.REFLEX_POLICY_PATH)
  : path.join(REPO_ROOT, 'config', 'reflex_policy.json');
const STATE_DIR = process.env.REFLEX_STATE_DIR
  ? path.resolve(process.env.REFLEX_STATE_DIR)
  : path.join(REPO_ROOT, 'state', 'adaptive', 'reflex');
const STATE_PATH = path.join(STATE_DIR, 'pool_state.json');
const EVENTS_PATH = path.join(STATE_DIR, 'events.jsonl');
const ROUTINES_PATH = process.env.REFLEX_ROUTINES_PATH
  ? path.resolve(process.env.REFLEX_ROUTINES_PATH)
  : path.join(STATE_DIR, 'routines.json');
const SPAWN_BROKER_SCRIPT = process.env.REFLEX_SPAWN_BROKER_SCRIPT
  ? path.resolve(process.env.REFLEX_SPAWN_BROKER_SCRIPT)
  : path.join(REPO_ROOT, 'systems', 'spawn', 'spawn_broker.js');
const SPAWN_MODULE = String(process.env.REFLEX_SPAWN_MODULE || 'reflex').trim() || 'reflex';
const WORKER_SCRIPT = process.env.REFLEX_WORKER_SCRIPT
  ? path.resolve(process.env.REFLEX_WORKER_SCRIPT)
  : path.join(REPO_ROOT, 'systems', 'reflex', 'reflex_worker.js');

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
  const row = obj && typeof obj === 'object' ? { ...obj } : {};
  const candidate = String(row.uid || '').trim();
  if (!candidate || !isAlnum(candidate)) {
    row.uid = randomUid({ prefix: 'r', length: 24 });
  }
  fs.appendFileSync(p, JSON.stringify(row) + '\n', 'utf8');
}

function parseArgs(argv: string[]): AnyObj {
  const out: AnyObj = { _: [] };
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
  console.log('  node systems/reflex/reflex_dispatcher.js status');
  console.log('  node systems/reflex/reflex_dispatcher.js plan --demand=N [--headroom=0.8] [--apply=1]');
  console.log('  node systems/reflex/reflex_dispatcher.js run --task="..." [--intent=..] [--tokens_est=N] [--demand=N] [--headroom=0.8]');
  console.log('  node systems/reflex/reflex_dispatcher.js routine-list [--id=<routine_id>] [--all=1]');
  console.log('  node systems/reflex/reflex_dispatcher.js routine-create --id=<routine_id> --task="..." [--intent=..] [--demand=N] [--headroom=0.8] [--tokens_est=N] [--description=..] [--tags=a,b] [--upsert=1]');
  console.log('  node systems/reflex/reflex_dispatcher.js routine-run --id=<routine_id> [--task=..] [--intent=..] [--demand=N] [--headroom=0.8] [--tokens_est=N]');
  console.log('  node systems/reflex/reflex_dispatcher.js routine-enable --id=<routine_id>');
  console.log('  node systems/reflex/reflex_dispatcher.js routine-disable --id=<routine_id>');
  console.log('  node systems/reflex/reflex_dispatcher.js routine-dispose --id=<routine_id>');
  console.log('  node systems/reflex/reflex_dispatcher.js --help');
}

function loadPolicy() {
  const raw = readJson(POLICY_PATH, {}) || {};
  const pool = raw.pool && typeof raw.pool === 'object' ? raw.pool : {};
  const routing = raw.routing && typeof raw.routing === 'object' ? raw.routing : {};
  const safety = raw.safety && typeof raw.safety === 'object' ? raw.safety : {};

  const minCells = Math.max(1, Math.round(Number(pool.min_cells || 1)));
  const maxCells = Math.max(minCells, Math.round(Number(pool.max_cells || 4)));

  return {
    version: String(raw.version || '1.0'),
    pool: {
      min_cells: minCells,
      max_cells: maxCells,
      queue_per_cell: clampNumber(pool.queue_per_cell, 1, 100, 2),
      scale_up_cooldown_sec: clampNumber(pool.scale_up_cooldown_sec, 0, 3600, 45),
      scale_down_cooldown_sec: clampNumber(pool.scale_down_cooldown_sec, 0, 7200, 180),
      demand_smoothing_alpha: clampNumber(pool.demand_smoothing_alpha, 0.05, 1, 0.35),
      max_step_up: clampNumber(pool.max_step_up, 1, 8, 2),
      max_step_down: clampNumber(pool.max_step_down, 1, 8, 1),
      headroom_floor: clampNumber(pool.headroom_floor, 0.1, 1, 0.2),
      reserve_cpu_threads: clampNumber(pool.reserve_cpu_threads, 0, 256, 2),
      reserve_ram_gb: clampNumber(pool.reserve_ram_gb, 0, 512, 4),
      estimated_cpu_threads_per_cell: clampNumber(pool.estimated_cpu_threads_per_cell, 0.1, 64, 1),
      estimated_ram_gb_per_cell: clampNumber(pool.estimated_ram_gb_per_cell, 0.1, 128, 1.2),
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
    routing: {
      route_class: String(routing.route_class || 'reflex'),
      risk: String(routing.risk || 'low'),
      complexity: String(routing.complexity || 'low'),
      default_role: String(routing.default_role || 'reflex'),
      default_tokens_est: clampNumber(routing.default_tokens_est, 50, 12000, 220),
      max_tokens_est: clampNumber(routing.max_tokens_est, 50, 12000, 420),
      timeout_ms: clampNumber(routing.timeout_ms, 500, 120000, 15000),
      capability: String(routing.capability || 'reflex_micro')
    },
    safety: {
      allow_external_writes: safety.allow_external_writes === true,
      max_retries: clampNumber(safety.max_retries, 0, 8, 1)
    }
  };
}

function defaultState(policy) {
  return {
    version: 1,
    uid: stableUid('adaptive_reflex_pool_state|v1', { prefix: 'rp', length: 24 }),
    ts: nowIso(),
    current_cells: policy.pool.min_cells,
    target_cells: policy.pool.min_cells,
    smoothed_demand: 0,
    last_scaled_at: null,
    last_scale_direction: 'init',
    last_reason: 'init',
    last_input: {
      demand: 0,
      headroom: 1
    }
  };
}

function loadState(policy) {
  const raw = readJson(STATE_PATH, null);
  if (!raw || typeof raw !== 'object') return defaultState(policy);
  const uidCandidate = String(raw.uid || '').trim();
  const uid = uidCandidate && isAlnum(uidCandidate)
    ? uidCandidate
    : stableUid('adaptive_reflex_pool_state|v1', { prefix: 'rp', length: 24 });
  const current = clampNumber(raw.current_cells, 0, policy.pool.max_cells, policy.pool.min_cells);
  const out = {
    version: 1,
    uid,
    ts: String(raw.ts || nowIso()),
    current_cells: current,
    target_cells: clampNumber(raw.target_cells, 0, policy.pool.max_cells, current),
    smoothed_demand: Math.max(0, Number(raw.smoothed_demand || 0)),
    last_scaled_at: raw.last_scaled_at || null,
    last_scale_direction: String(raw.last_scale_direction || 'hold'),
    last_reason: String(raw.last_reason || ''),
    last_input: raw.last_input && typeof raw.last_input === 'object'
      ? raw.last_input
      : { demand: 0, headroom: 1 }
  };
  if (uid !== uidCandidate) writeJsonAtomic(STATE_PATH, out);
  return out;
}

function normalizeRoutineId(v) {
  return String(v || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9:_-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
}

function parseTags(raw) {
  if (Array.isArray(raw)) {
    return raw.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 16);
  }
  return String(raw || '')
    .split(',')
    .map((x) => String(x || '').trim())
    .filter(Boolean)
    .slice(0, 16);
}

function defaultRoutinesRegistry() {
  return {
    version: 1,
    updated_at: nowIso(),
    routines: {}
  };
}

function normalizeRoutineRecord(id, raw, policy) {
  if (!raw || typeof raw !== 'object') return null;
  const rid = normalizeRoutineId(raw.id || id);
  if (!rid) return null;
  const uidCandidate = String(raw.uid || '').trim();
  const uid = uidCandidate && isAlnum(uidCandidate)
    ? uidCandidate
    : stableUid(`adaptive_reflex_routine|${rid}|v1`, { prefix: 'rr', length: 24 });
  const status = String(raw.status || 'enabled').trim().toLowerCase() === 'disabled'
    ? 'disabled'
    : 'enabled';
  const task = String(raw.task || '').trim();
  return {
    uid,
    id: rid,
    status,
    task,
    intent: String(raw.intent || '').trim(),
    description: String(raw.description || '').trim(),
    demand: Math.max(0, Number(raw.demand || 0) || 0),
    headroom: clampNumber(raw.headroom, 0.05, 1, 1),
    tokens_est: Math.max(
      50,
      Math.min(
        Number(policy.routing.max_tokens_est),
        Math.round(Number(raw.tokens_est || raw.tokensEst || policy.routing.default_tokens_est) || policy.routing.default_tokens_est)
      )
    ),
    tags: parseTags(raw.tags),
    created_by: String(raw.created_by || raw.createdBy || 'manual').slice(0, 80),
    created_at: String(raw.created_at || raw.createdAt || nowIso()),
    updated_at: String(raw.updated_at || raw.updatedAt || nowIso()),
    use_count: Math.max(0, Math.round(Number(raw.use_count || 0) || 0)),
    last_run_at: raw.last_run_at || null
  };
}

function loadRoutinesRegistry(policy, options: AnyObj = {}) {
  const persist = options && options.persist === true;
  const raw = readJson(ROUTINES_PATH, null);
  if (!raw || typeof raw !== 'object') return defaultRoutinesRegistry();
  const routinesIn = raw.routines && typeof raw.routines === 'object' ? raw.routines : {};
  const routines: AnyObj = {};
  let changed = false;
  for (const [k, vRaw] of Object.entries(routinesIn as AnyObj)) {
    const v: AnyObj = (vRaw as AnyObj) || {};
    const rec = normalizeRoutineRecord(k, v, policy);
    if (!rec || !rec.id) {
      changed = true;
      continue;
    }
    const priorUid = String(v && v.uid || '').trim();
    if (priorUid !== rec.uid) changed = true;
    routines[rec.id] = rec;
  }
  const out = {
    version: 1,
    updated_at: String(raw.updated_at || nowIso()),
    routines
  };
  if (persist && changed) saveRoutinesRegistry(out);
  return out;
}

function saveRoutinesRegistry(registry) {
  const out = registry && typeof registry === 'object' ? registry : defaultRoutinesRegistry();
  if (!out.routines || typeof out.routines !== 'object') out.routines = {};
  out.version = 1;
  out.updated_at = nowIso();
  writeJsonAtomic(ROUTINES_PATH, out);
}

function routinesSummary(registry) {
  const rows: AnyObj[] = Object.values(
    registry && registry.routines && typeof registry.routines === 'object'
      ? (registry.routines as AnyObj)
      : {}
  );
  const enabled = rows.filter((r: AnyObj) => r && r.status === 'enabled').length;
  const disabled = rows.filter((r: AnyObj) => r && r.status === 'disabled').length;
  return {
    total: rows.length,
    enabled,
    disabled
  };
}

function resolveRoutine(registry, routineId) {
  const rid = normalizeRoutineId(routineId);
  if (!rid) return null;
  return registry && registry.routines && typeof registry.routines === 'object'
    ? (registry.routines[rid] || null)
    : null;
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
      try { return JSON.parse(s); } catch {}
    }
    return null;
  }
}

function backfillEventUids() {
  if (!fs.existsSync(EVENTS_PATH)) return { scanned: 0, updated: 0 };
  const lines = fs.readFileSync(EVENTS_PATH, 'utf8').split('\n').filter(Boolean);
  if (!lines.length) return { scanned: 0, updated: 0 };
  const out = [];
  let updated = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = String(lines[i] || '').trim();
    if (!line) continue;
    try {
      const row = JSON.parse(line);
      const candidate = String(row && row.uid || '').trim();
      if (!candidate || !isAlnum(candidate)) {
        row.uid = stableUid(`adaptive_reflex_event|${i}|${String(row && row.ts || '')}|${String(row && row.type || '')}|${line}`, { prefix: 're', length: 24 });
        updated++;
      }
      out.push(JSON.stringify(row));
    } catch {
      out.push(line);
    }
  }
  if (updated > 0) {
    ensureDir(path.dirname(EVENTS_PATH));
    fs.writeFileSync(EVENTS_PATH, out.join('\n') + '\n', 'utf8');
  }
  return { scanned: lines.length, updated };
}

function ensureAdaptiveUids(policy) {
  const state = loadState(policy);
  const routines = loadRoutinesRegistry(policy, { persist: true });
  const events = backfillEventUids();
  return {
    state_uid: state && state.uid ? state.uid : null,
    routines_total: Object.keys((routines && routines.routines) || {}).length,
    events_scanned: events.scanned,
    events_updated: events.updated
  };
}

function spawnBrokerCall(args) {
  const r = spawnSync('node', [SPAWN_BROKER_SCRIPT, ...args], { cwd: REPO_ROOT, encoding: 'utf8' });
  const payload = safeJson(r.stdout);
  return {
    ok: r.status === 0 && !!payload,
    status: r.status,
    payload,
    error: String(r.stderr || '').trim().slice(0, 240)
  };
}

function spawnBrokerStatus() {
  return spawnBrokerCall(['status', `--module=${SPAWN_MODULE}`]);
}

function spawnBrokerRequest(requestedCells, reason, apply) {
  const args = [
    'request',
    `--module=${SPAWN_MODULE}`,
    `--requested_cells=${Math.max(0, Math.round(Number(requestedCells || 0)))}`,
    `--reason=${String(reason || '').slice(0, 120)}`,
    `--apply=${apply ? 1 : 0}`
  ];
  return spawnBrokerCall(args);
}

function spawnCapacityBounds(policy, statusPayload) {
  const limits = statusPayload && statusPayload.limits && typeof statusPayload.limits === 'object'
    ? statusPayload.limits
    : {};
  const hardware = statusPayload && statusPayload.hardware_bounds && typeof statusPayload.hardware_bounds === 'object'
    ? statusPayload.hardware_bounds
    : {};
  const maxCells = clampNumber(
    limits.max_cells,
    0,
    policy.pool.max_cells,
    policy.pool.max_cells
  );
  return {
    source: 'spawn_broker',
    module: SPAWN_MODULE,
    max_cells: maxCells,
    module_current_cells: Number.isFinite(Number(limits.module_current_cells))
      ? Number(limits.module_current_cells)
      : null,
    module_quota_max_cells: Number.isFinite(Number(limits.module_quota_max_cells))
      ? Number(limits.module_quota_max_cells)
      : null,
    global_max_cells: Number.isFinite(Number(limits.global_max_cells))
      ? Number(limits.global_max_cells)
      : null,
    hardware_class: hardware.hardware_class || null,
    cpu_threads: Number.isFinite(Number(hardware.cpu_threads)) ? Number(hardware.cpu_threads) : null,
    ram_gb: Number.isFinite(Number(hardware.ram_gb)) ? Number(hardware.ram_gb) : null
  };
}

function computeDemandInput(args) {
  const demandRaw = args.demand != null ? args.demand : args['queue-depth'];
  const demand = Math.max(0, Number(demandRaw || 0));
  const headroom = clampNumber(args.headroom, 0.05, 1, 1);
  return {
    demand: Number.isFinite(demand) ? demand : 0,
    headroom
  };
}

function secondsSince(isoTs) {
  if (!isoTs) return Infinity;
  const d = new Date(String(isoTs));
  if (Number.isNaN(d.getTime())) return Infinity;
  return Math.max(0, (Date.now() - d.getTime()) / 1000);
}

function planNextState(policy, state, input, hardwareBounds) {
  const pool = policy.pool;
  const alpha = Number(pool.demand_smoothing_alpha);
  const smoothed = Number((alpha * input.demand + (1 - alpha) * Number(state.smoothed_demand || 0)).toFixed(3));
  const effectiveHeadroom = Math.max(pool.headroom_floor, Number(input.headroom || 1));
  const adjustedDemand = smoothed / effectiveHeadroom;
  const rawTarget = Math.ceil(adjustedDemand / Number(pool.queue_per_cell || 1));

  const maxCells = Math.max(0, Math.min(pool.max_cells, Number(hardwareBounds.max_cells || pool.max_cells)));
  const effectiveMin = Math.min(pool.min_cells, maxCells);
  const target = Math.max(effectiveMin, Math.min(maxCells, rawTarget));

  const currentRaw = Number(state.current_cells);
  const current = Number.isFinite(currentRaw)
    ? Math.max(0, Math.min(pool.max_cells, currentRaw))
    : effectiveMin;
  const elapsedSec = secondsSince(state.last_scaled_at);

  let nextCells = current;
  let direction = 'hold';
  let reason = 'within_band';

  if (target > current) {
    if (elapsedSec < Number(pool.scale_up_cooldown_sec || 0)) {
      direction = 'hold';
      reason = 'scale_up_cooldown';
    } else {
      const step = Math.min(Number(pool.max_step_up || 1), target - current);
      nextCells = current + step;
      direction = 'up';
      reason = 'demand_increase';
    }
  } else if (target < current) {
    if (elapsedSec < Number(pool.scale_down_cooldown_sec || 0)) {
      direction = 'hold';
      reason = 'scale_down_cooldown';
    } else {
      const step = Math.min(Number(pool.max_step_down || 1), current - target);
      nextCells = current - step;
      direction = 'down';
      reason = 'demand_decrease';
    }
  }

  nextCells = Math.max(effectiveMin, Math.min(maxCells, Math.round(nextCells)));

  return {
    ts: nowIso(),
    current_cells: current,
    target_cells: target,
    next_cells: nextCells,
    smoothed_demand: smoothed,
    adjusted_demand: Number(adjustedDemand.toFixed(3)),
    headroom: input.headroom,
    direction,
    reason,
    elapsed_since_scale_sec: Number(elapsedSec.toFixed(1)),
    hardware_bounds: hardwareBounds
  };
}

function applyState(policy, prevState, plan) {
  const allocation = plan && plan.spawn_allocation && typeof plan.spawn_allocation === 'object'
    ? plan.spawn_allocation
    : null;
  const grantedCells = allocation && Number.isFinite(Number(allocation.granted_cells))
    ? clampNumber(Number(allocation.granted_cells), 0, policy.pool.max_cells, plan.next_cells)
    : plan.next_cells;
  const next = {
    version: 1,
    uid: String(prevState && prevState.uid || '').trim() && isAlnum(String(prevState.uid || '').trim())
      ? String(prevState.uid).trim()
      : stableUid('adaptive_reflex_pool_state|v1', { prefix: 'rp', length: 24 }),
    ts: plan.ts,
    current_cells: grantedCells,
    target_cells: plan.target_cells,
    smoothed_demand: plan.smoothed_demand,
    last_scaled_at: plan.direction === 'hold' ? prevState.last_scaled_at : plan.ts,
    last_scale_direction: plan.direction,
    last_reason: plan.reason,
    last_input: {
      demand: Number(plan.adjusted_demand || 0),
      headroom: Number(plan.headroom || 1)
    }
  };
  writeJsonAtomic(STATE_PATH, next);
  appendJsonl(EVENTS_PATH, {
    ts: nowIso(),
    type: 'reflex_pool_tick',
    from_cells: plan.current_cells,
    to_cells: grantedCells,
    requested_cells: plan.next_cells,
    granted_cells: grantedCells,
    target_cells: plan.target_cells,
    direction: plan.direction,
    reason: plan.reason,
    smoothed_demand: plan.smoothed_demand,
    adjusted_demand: plan.adjusted_demand,
    headroom: plan.headroom,
    hardware_bounds: plan.hardware_bounds,
    spawn_limits: allocation && allocation.limits ? allocation.limits : null
  });
  return next;
}

function runWorker(policy, args) {
  const task = String(args.task || '').trim();
  if (!task) {
    return { ok: false, error: 'missing_task' };
  }

  const intent = String(args.intent || 'reflex_dispatch').trim();
  const rawTokens = Number(args.tokens_est || args['tokens-est'] || policy.routing.default_tokens_est);
  const tokensEst = Math.max(50, Math.min(Number(policy.routing.max_tokens_est), Math.round(rawTokens || policy.routing.default_tokens_est)));

  const workerId = String(args['worker-id'] || args.worker_id || `cell-${Date.now()}`).trim();
  const execArgs = [
    WORKER_SCRIPT,
    'once',
    `--worker-id=${workerId}`,
    `--intent=${intent}`,
    `--task=${task}`,
    `--tokens_est=${tokensEst}`
  ];

  const r = spawnSync('node', execArgs, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: Number(policy.routing.timeout_ms || 15000)
  });
  const payload = safeJson(r.stdout);
  const out = {
    ok: r.status === 0 && !!payload,
    status: r.status,
    result: payload,
    stderr: String(r.stderr || '').trim().slice(0, 240)
  };
  appendJsonl(EVENTS_PATH, {
    ts: nowIso(),
    type: 'reflex_worker_run',
    worker_id: workerId,
    ok: out.ok,
    task_hash: String(task).length,
    selected_model: payload && payload.route ? payload.route.selected_model || null : null,
    route_class: payload && payload.route ? payload.route.route_class || null : null,
    stderr: out.stderr || null
  });
  return out;
}

function dispatchRun(policy, state, args, context: AnyObj = {}) {
  const input = computeDemandInput(args);
  const spawnStatus = spawnBrokerStatus();
  const bounds = spawnCapacityBounds(policy, spawnStatus.payload || {});
  const plan = planNextState(policy, state, input, bounds);
  const allocation = spawnBrokerRequest(plan.next_cells, `reflex_${plan.reason}`, true);
  if (!allocation.ok) {
    return {
      ok: false,
      ts: nowIso(),
      error: 'spawn_request_failed',
      spawn_error: allocation.error || null,
      plan,
      spawn_status_ok: spawnStatus.ok,
      spawn_status_error: spawnStatus.ok ? null : spawnStatus.error
    };
  }
  const planApplied = { ...plan, spawn_allocation: allocation.payload };
  const nextState = applyState(policy, state, planApplied);
  const worker = runWorker(policy, args);
  const out: AnyObj = {
    ok: spawnStatus.ok && worker.ok,
    ts: nowIso(),
    pool: {
      before_cells: plan.current_cells,
      after_cells: nextState.current_cells,
      target_cells: plan.target_cells,
      direction: plan.direction,
      reason: plan.reason
    },
    worker,
    hardware_bounds: bounds,
    spawn_status_ok: spawnStatus.ok,
    spawn_status_error: spawnStatus.ok ? null : spawnStatus.error
  };
  if (context && context.routine_id) out.routine_id = String(context.routine_id);
  return out;
}

function cmdStatus(_args: AnyObj = {}) {
  const policy = loadPolicy();
  const uidSync = ensureAdaptiveUids(policy);
  const state = loadState(policy);
  const spawnStatus = spawnBrokerStatus();
  const bounds = spawnCapacityBounds(policy, spawnStatus.payload || {});
  const routines = loadRoutinesRegistry(policy, { persist: true });
  process.stdout.write(JSON.stringify({
    ok: spawnStatus.ok,
    ts: nowIso(),
    policy,
    state,
    routines: routinesSummary(routines),
    adaptive_uid_sync: uidSync,
    spawn_status_ok: spawnStatus.ok,
    spawn_status_error: spawnStatus.ok ? null : spawnStatus.error,
    hardware_bounds: bounds
  }, null, 2) + '\n');
  if (!spawnStatus.ok) process.exit(1);
}

function cmdPlan(args) {
  const policy = loadPolicy();
  const uidSync = ensureAdaptiveUids(policy);
  const state = loadState(policy);
  const input = computeDemandInput(args);
  const spawnStatus = spawnBrokerStatus();
  const bounds = spawnCapacityBounds(policy, spawnStatus.payload || {});
  const plan = planNextState(policy, state, input, bounds);
  const apply = String(args.apply || '0') === '1';

  let allocation = null;
  if (apply) {
    allocation = spawnBrokerRequest(plan.next_cells, `reflex_${plan.reason}`, true);
    if (!allocation.ok) {
      process.stdout.write(JSON.stringify({
        ok: false,
        ts: nowIso(),
        error: 'spawn_request_failed',
        spawn_error: allocation.error || null,
        plan,
        spawn_status_ok: spawnStatus.ok,
        spawn_status_error: spawnStatus.ok ? null : spawnStatus.error
      }, null, 2) + '\n');
      process.exit(1);
    }
  }
  const planApplied = allocation && allocation.payload
    ? { ...plan, spawn_allocation: allocation.payload }
    : plan;
  const nextState = apply ? applyState(policy, state, planApplied) : null;

  process.stdout.write(JSON.stringify({
    ok: spawnStatus.ok && (!apply || !!allocation),
    ts: nowIso(),
    adaptive_uid_sync: uidSync,
    apply,
    plan: planApplied,
    next_state: nextState,
    spawn_status_ok: spawnStatus.ok,
    spawn_status_error: spawnStatus.ok ? null : spawnStatus.error
  }, null, 2) + '\n');
  if (!spawnStatus.ok) process.exit(1);
}

function cmdRun(args) {
  const policy = loadPolicy();
  ensureAdaptiveUids(policy);
  const state = loadState(policy);
  const out = dispatchRun(policy, state, args);
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  if (!out.ok) process.exit(1);
}

function cmdRoutineList(args) {
  const policy = loadPolicy();
  const uidSync = ensureAdaptiveUids(policy);
  const registry = loadRoutinesRegistry(policy, { persist: true });
  const requestedId = normalizeRoutineId(args.id || '');
  const includeAll = toBool(args.all, true);
  let rows: AnyObj[] = Object.values((registry.routines as AnyObj) || {})
    .sort((a: AnyObj, b: AnyObj) => String(a.id).localeCompare(String(b.id)));
  if (!includeAll) rows = rows.filter((r: AnyObj) => r.status === 'enabled');
  if (requestedId) rows = rows.filter((r: AnyObj) => r.id === requestedId);
  process.stdout.write(JSON.stringify({
    ok: true,
    ts: nowIso(),
    adaptive_uid_sync: uidSync,
    summary: routinesSummary(registry),
    routines: rows
  }, null, 2) + '\n');
}

function cmdRoutineCreate(args) {
  const policy = loadPolicy();
  ensureAdaptiveUids(policy);
  const registry = loadRoutinesRegistry(policy, { persist: true });
  const id = normalizeRoutineId(args.id || '');
  if (!id) {
    process.stdout.write(JSON.stringify({
      ok: false,
      ts: nowIso(),
      error: 'missing_id'
    }, null, 2) + '\n');
    process.exit(2);
  }
  const task = String(args.task || '').trim();
  if (!task) {
    process.stdout.write(JSON.stringify({
      ok: false,
      ts: nowIso(),
      error: 'missing_task'
    }, null, 2) + '\n');
    process.exit(2);
  }
  const upsert = toBool(args.upsert, false);
  const existing = registry.routines[id] || null;
  if (existing && !upsert) {
    process.stdout.write(JSON.stringify({
      ok: false,
      ts: nowIso(),
      error: 'routine_exists',
      id
    }, null, 2) + '\n');
    process.exit(2);
  }
  const tokensRaw = Number(args.tokens_est != null ? args.tokens_est : args['tokens-est']);
  const tokens = Number.isFinite(tokensRaw)
    ? Math.max(50, Math.min(Number(policy.routing.max_tokens_est), Math.round(tokensRaw)))
    : (existing ? Number(existing.tokens_est || policy.routing.default_tokens_est) : Number(policy.routing.default_tokens_est));
  const rec = {
    uid: existing && String(existing.uid || '').trim() && isAlnum(String(existing.uid || '').trim())
      ? String(existing.uid).trim()
      : stableUid(`adaptive_reflex_routine|${id}|v1`, { prefix: 'rr', length: 24 }),
    id,
    status: String(args.status || (existing ? existing.status : 'enabled')).toLowerCase() === 'disabled' ? 'disabled' : 'enabled',
    task,
    intent: String(args.intent != null ? args.intent : (existing ? existing.intent : '')).trim(),
    description: String(args.description != null ? args.description : (existing ? existing.description : '')).trim(),
    demand: Math.max(0, Number(args.demand != null ? args.demand : (existing ? existing.demand : 0)) || 0),
    headroom: clampNumber(args.headroom != null ? args.headroom : (existing ? existing.headroom : 1), 0.05, 1, 1),
    tokens_est: tokens,
    tags: args.tags != null ? parseTags(args.tags) : (existing ? parseTags(existing.tags) : []),
    created_by: String(args['created-by'] || args.created_by || (existing ? existing.created_by : 'manual')).slice(0, 80),
    created_at: existing ? String(existing.created_at || nowIso()) : nowIso(),
    updated_at: nowIso(),
    use_count: existing ? Math.max(0, Math.round(Number(existing.use_count || 0) || 0)) : 0,
    last_run_at: existing ? (existing.last_run_at || null) : null
  };
  registry.routines[id] = rec;
  saveRoutinesRegistry(registry);
  appendJsonl(EVENTS_PATH, {
    ts: nowIso(),
    type: existing ? 'reflex_routine_updated' : 'reflex_routine_created',
    routine_id: id,
    status: rec.status
  });
  process.stdout.write(JSON.stringify({
    ok: true,
    ts: nowIso(),
    result: existing ? 'updated' : 'created',
    routine: rec,
    summary: routinesSummary(registry)
  }, null, 2) + '\n');
}

function cmdRoutineSetStatus(args, status) {
  const policy = loadPolicy();
  ensureAdaptiveUids(policy);
  const registry = loadRoutinesRegistry(policy, { persist: true });
  const id = normalizeRoutineId(args.id || '');
  const rec = resolveRoutine(registry, id);
  if (!id || !rec) {
    process.stdout.write(JSON.stringify({
      ok: false,
      ts: nowIso(),
      error: 'routine_not_found',
      id: id || null
    }, null, 2) + '\n');
    process.exit(2);
  }
  rec.status = status;
  rec.updated_at = nowIso();
  registry.routines[id] = rec;
  saveRoutinesRegistry(registry);
  appendJsonl(EVENTS_PATH, {
    ts: nowIso(),
    type: status === 'enabled' ? 'reflex_routine_enabled' : 'reflex_routine_disabled',
    routine_id: id
  });
  process.stdout.write(JSON.stringify({
    ok: true,
    ts: nowIso(),
    result: status === 'enabled' ? 'enabled' : 'disabled',
    routine: rec
  }, null, 2) + '\n');
}

function cmdRoutineDispose(args) {
  const policy = loadPolicy();
  ensureAdaptiveUids(policy);
  const registry = loadRoutinesRegistry(policy, { persist: true });
  const id = normalizeRoutineId(args.id || '');
  const rec = resolveRoutine(registry, id);
  if (!id || !rec) {
    process.stdout.write(JSON.stringify({
      ok: false,
      ts: nowIso(),
      error: 'routine_not_found',
      id: id || null
    }, null, 2) + '\n');
    process.exit(2);
  }
  delete registry.routines[id];
  saveRoutinesRegistry(registry);
  appendJsonl(EVENTS_PATH, {
    ts: nowIso(),
    type: 'reflex_routine_disposed',
    routine_id: id
  });
  process.stdout.write(JSON.stringify({
    ok: true,
    ts: nowIso(),
    result: 'disposed',
    routine_id: id,
    summary: routinesSummary(registry)
  }, null, 2) + '\n');
}

function cmdRoutineRun(args) {
  const policy = loadPolicy();
  ensureAdaptiveUids(policy);
  const registry = loadRoutinesRegistry(policy, { persist: true });
  const id = normalizeRoutineId(args.id || '');
  const rec = resolveRoutine(registry, id);
  if (!id || !rec) {
    process.stdout.write(JSON.stringify({
      ok: false,
      ts: nowIso(),
      error: 'routine_not_found',
      id: id || null
    }, null, 2) + '\n');
    process.exit(2);
  }
  if (rec.status !== 'enabled') {
    process.stdout.write(JSON.stringify({
      ok: false,
      ts: nowIso(),
      error: 'routine_disabled',
      routine_id: id
    }, null, 2) + '\n');
    process.exit(1);
  }
  const runArgs = {
    ...args,
    task: args.task != null ? args.task : rec.task,
    intent: args.intent != null ? args.intent : rec.intent,
    demand: args.demand != null ? args.demand : rec.demand,
    headroom: args.headroom != null ? args.headroom : rec.headroom,
    tokens_est: (args.tokens_est != null || args['tokens-est'] != null)
      ? (args.tokens_est != null ? args.tokens_est : args['tokens-est'])
      : rec.tokens_est
  };
  const state = loadState(policy);
  const out: AnyObj = dispatchRun(policy, state, runArgs, { routine_id: id });
  rec.use_count = Math.max(0, Math.round(Number(rec.use_count || 0) || 0)) + 1;
  rec.last_run_at = nowIso();
  rec.updated_at = rec.last_run_at;
  registry.routines[id] = rec;
  saveRoutinesRegistry(registry);
  appendJsonl(EVENTS_PATH, {
    ts: nowIso(),
    type: 'reflex_routine_run',
    routine_id: id,
    ok: out.ok === true,
    selected_model: out.worker && out.worker.result && out.worker.result.route
      ? out.worker.result.route.selected_model || null
      : null
  });
  process.stdout.write(JSON.stringify({
    ...out,
    routine: {
      id: rec.id,
      status: rec.status,
      use_count: rec.use_count,
      last_run_at: rec.last_run_at
    }
  }, null, 2) + '\n');

  if (!out.ok) process.exit(1);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim();
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'status') return cmdStatus(args);
  if (cmd === 'plan') return cmdPlan(args);
  if (cmd === 'run') return cmdRun(args);
  if (cmd === 'routine-list') return cmdRoutineList(args);
  if (cmd === 'routine-create') return cmdRoutineCreate(args);
  if (cmd === 'routine-run') return cmdRoutineRun(args);
  if (cmd === 'routine-enable') return cmdRoutineSetStatus(args, 'enabled');
  if (cmd === 'routine-disable') return cmdRoutineSetStatus(args, 'disabled');
  if (cmd === 'routine-dispose') return cmdRoutineDispose(args);
  usage();
  process.exit(2);
}

main();
