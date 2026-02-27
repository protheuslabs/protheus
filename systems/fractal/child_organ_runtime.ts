#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const POLICY_PATH = process.env.CHILD_ORGAN_RUNTIME_POLICY_PATH
  ? path.resolve(process.env.CHILD_ORGAN_RUNTIME_POLICY_PATH)
  : path.join(ROOT, 'config', 'child_organ_runtime_policy.json');
const STATE_PATH = process.env.CHILD_ORGAN_RUNTIME_STATE_PATH
  ? path.resolve(process.env.CHILD_ORGAN_RUNTIME_STATE_PATH)
  : path.join(ROOT, 'state', 'fractal', 'child_organ_runtime', 'state.json');
const RECEIPTS_PATH = process.env.CHILD_ORGAN_RUNTIME_RECEIPTS_PATH
  ? path.resolve(process.env.CHILD_ORGAN_RUNTIME_RECEIPTS_PATH)
  : path.join(ROOT, 'state', 'fractal', 'child_organ_runtime', 'receipts.jsonl');

function nowIso() {
  return new Date().toISOString();
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
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  return fallback;
}

function cleanText(v: unknown, maxLen = 220) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeToken(v: unknown, maxLen = 120) {
  return cleanText(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.:/-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (const token of argv) {
    if (!token.startsWith('--')) {
      out._.push(token);
      continue;
    }
    const i = token.indexOf('=');
    if (i < 0) out[token.slice(2)] = true;
    else out[token.slice(2, i)] = token.slice(i + 1);
  }
  return out;
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath: string, fallback: any) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const payload = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return payload == null ? fallback : payload;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath: string, value: any) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${Date.now()}-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function appendJsonl(filePath: string, row: AnyObj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function sha(input: unknown) {
  return crypto.createHash('sha256').update(String(input == null ? '' : input)).digest('hex');
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    shadow_only: true,
    max_children: 24,
    default_ttl_hours: 24,
    max_ttl_hours: 168,
    resource_envelope: {
      token_cap_default: 800,
      token_cap_max: 5000,
      memory_mb_default: 512,
      memory_mb_max: 8192,
      cpu_threads_default: 2,
      cpu_threads_max: 16
    },
    lanes: {
      nursery: {
        enabled: true,
        script: 'systems/nursery/nursery_bootstrap.js',
        args: ['status']
      },
      redteam: {
        enabled: true,
        script: 'systems/redteam/ant_colony_controller.js',
        args: ['status']
      },
      evolution: {
        enabled: true,
        script: 'systems/autonomy/improvement_controller.js',
        args: ['status']
      }
    },
    rollback: {
      require_receipts: true,
      rollback_reason_default: 'child_lane_failure'
    }
  };
}

function normalizeLane(input: AnyObj, fallback: AnyObj) {
  const src = input && typeof input === 'object' ? input : {};
  const fb = fallback && typeof fallback === 'object' ? fallback : {};
  return {
    enabled: src.enabled !== false && fb.enabled !== false,
    script: cleanText(src.script || fb.script || '', 300),
    args: Array.isArray(src.args)
      ? src.args.map((v: unknown) => cleanText(v, 160)).filter(Boolean)
      : (Array.isArray(fb.args) ? fb.args : [])
  };
}

function loadPolicy(policyPath = POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const lanes = raw.lanes && typeof raw.lanes === 'object' ? raw.lanes : {};
  return {
    version: cleanText(raw.version || base.version, 40) || base.version,
    enabled: raw.enabled !== false,
    shadow_only: raw.shadow_only !== false,
    max_children: clampInt(raw.max_children, 1, 256, base.max_children),
    default_ttl_hours: clampInt(raw.default_ttl_hours, 1, 24 * 30, base.default_ttl_hours),
    max_ttl_hours: clampInt(raw.max_ttl_hours, 1, 24 * 180, base.max_ttl_hours),
    resource_envelope: {
      token_cap_default: clampInt(raw.resource_envelope && raw.resource_envelope.token_cap_default, 1, 500000, base.resource_envelope.token_cap_default),
      token_cap_max: clampInt(raw.resource_envelope && raw.resource_envelope.token_cap_max, 1, 500000, base.resource_envelope.token_cap_max),
      memory_mb_default: clampInt(raw.resource_envelope && raw.resource_envelope.memory_mb_default, 64, 1048576, base.resource_envelope.memory_mb_default),
      memory_mb_max: clampInt(raw.resource_envelope && raw.resource_envelope.memory_mb_max, 64, 1048576, base.resource_envelope.memory_mb_max),
      cpu_threads_default: clampInt(raw.resource_envelope && raw.resource_envelope.cpu_threads_default, 1, 1024, base.resource_envelope.cpu_threads_default),
      cpu_threads_max: clampInt(raw.resource_envelope && raw.resource_envelope.cpu_threads_max, 1, 1024, base.resource_envelope.cpu_threads_max)
    },
    lanes: {
      nursery: normalizeLane(lanes.nursery, base.lanes.nursery),
      redteam: normalizeLane(lanes.redteam, base.lanes.redteam),
      evolution: normalizeLane(lanes.evolution, base.lanes.evolution)
    },
    rollback: {
      require_receipts: raw.rollback ? raw.rollback.require_receipts !== false : base.rollback.require_receipts,
      rollback_reason_default: cleanText(raw.rollback && raw.rollback.rollback_reason_default || base.rollback.rollback_reason_default, 160)
    }
  };
}

function defaultState() {
  return {
    schema_id: 'child_organ_runtime_state',
    schema_version: '1.0',
    updated_at: nowIso(),
    children: {},
    runs: {}
  };
}

function loadState() {
  const src = readJson(STATE_PATH, null);
  if (!src || typeof src !== 'object') return defaultState();
  return {
    schema_id: 'child_organ_runtime_state',
    schema_version: '1.0',
    updated_at: cleanText(src.updated_at || nowIso(), 64),
    children: src.children && typeof src.children === 'object' ? src.children : {},
    runs: src.runs && typeof src.runs === 'object' ? src.runs : {}
  };
}

function saveState(state: AnyObj) {
  writeJsonAtomic(STATE_PATH, {
    schema_id: 'child_organ_runtime_state',
    schema_version: '1.0',
    updated_at: nowIso(),
    children: state && state.children && typeof state.children === 'object' ? state.children : {},
    runs: state && state.runs && typeof state.runs === 'object' ? state.runs : {}
  });
}

function parseContracts(raw: unknown) {
  try {
    const parsed = JSON.parse(String(raw || '{}'));
    const out = parsed && typeof parsed === 'object' ? parsed : {};
    return {
      parent_contract_id: normalizeToken(out.parent_contract_id || '', 120) || null,
      clearance_limit: normalizeToken(out.clearance_limit || 'L1', 40) || 'L1',
      inheritance_mode: normalizeToken(out.inheritance_mode || 'strict', 40) || 'strict',
      rollback_required: out.rollback_required !== false
    };
  } catch {
    return {
      parent_contract_id: null,
      clearance_limit: 'L1',
      inheritance_mode: 'strict',
      rollback_required: true
    };
  }
}

function laneCall(laneName: string, laneCfg: AnyObj, child: AnyObj) {
  const scriptPath = path.resolve(ROOT, cleanText(laneCfg.script || '', 300));
  const args = Array.isArray(laneCfg.args) ? laneCfg.args.map((v: unknown) => cleanText(v, 160)).filter(Boolean) : [];
  if (!scriptPath || !fs.existsSync(scriptPath)) {
    return {
      lane: laneName,
      ok: false,
      error: 'lane_script_missing',
      script: path.relative(ROOT, scriptPath).replace(/\\/g, '/')
    };
  }
  const proc = spawnSync(process.execPath, [scriptPath, ...args, `--child-id=${child.child_id}`, `--parent-id=${child.parent_id}`], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120000
  });
  const status = Number(proc.status);
  return {
    lane: laneName,
    ok: status === 0,
    status,
    script: path.relative(ROOT, scriptPath).replace(/\\/g, '/'),
    stderr: cleanText(proc.stderr, 600),
    stdout: cleanText(proc.stdout, 600)
  };
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/fractal/child_organ_runtime.js spawn --child-id=<id> --parent-id=<id> [--objective=...] [--ttl-hours=24] [--token-cap=800] [--memory-mb=512] [--cpu-threads=2] [--contracts-json={...}]');
  console.log('  node systems/fractal/child_organ_runtime.js run --child-id=<id> [--apply=1|0]');
  console.log('  node systems/fractal/child_organ_runtime.js rollback --child-id=<id> [--reason=...]');
  console.log('  node systems/fractal/child_organ_runtime.js status [--child-id=<id>]');
}

function cmdSpawn(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : POLICY_PATH);
  const state = loadState();
  const childId = normalizeToken(args.child_id || args['child-id'] || `child_${Date.now().toString(36)}`, 120);
  const parentId = normalizeToken(args.parent_id || args['parent-id'] || '', 120);
  if (!childId || !parentId) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'child_organ_spawn', error: 'child_id_and_parent_id_required' })}\n`);
    process.exit(1);
  }
  const existingCount = Object.keys(state.children || {}).filter((id) => state.children[id] && state.children[id].status !== 'rolled_back').length;
  if (existingCount >= policy.max_children && !state.children[childId]) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'child_organ_spawn', error: 'max_children_reached', max_children: policy.max_children })}\n`);
    process.exit(1);
  }

  const ttlHours = clampInt(args.ttl_hours || args['ttl-hours'], 1, policy.max_ttl_hours, policy.default_ttl_hours);
  const envelope = {
    token_cap: clampInt(args.token_cap || args['token-cap'], 1, policy.resource_envelope.token_cap_max, policy.resource_envelope.token_cap_default),
    memory_mb: clampInt(args.memory_mb || args['memory-mb'], 64, policy.resource_envelope.memory_mb_max, policy.resource_envelope.memory_mb_default),
    cpu_threads: clampInt(args.cpu_threads || args['cpu-threads'], 1, policy.resource_envelope.cpu_threads_max, policy.resource_envelope.cpu_threads_default)
  };
  const contracts = parseContracts(args.contracts_json || args['contracts-json']);
  const createdAt = nowIso();
  const expiresAt = new Date(Date.parse(createdAt) + ttlHours * 60 * 60 * 1000).toISOString();
  const childRecord = {
    child_id: childId,
    parent_id: parentId,
    objective: cleanText(args.objective || 'recursive_child_runtime', 240),
    status: 'spawned',
    created_at: createdAt,
    expires_at: expiresAt,
    ttl_hours: ttlHours,
    policy_version: policy.version,
    policy_hash: sha(JSON.stringify(policy)).slice(0, 24),
    contracts,
    envelope,
    lanes: Object.fromEntries(Object.entries(policy.lanes).map(([lane, cfg]: [string, AnyObj]) => [lane, { enabled: cfg.enabled === true }])),
    rollback: null
  };

  state.children[childId] = childRecord;
  saveState(state);
  appendJsonl(RECEIPTS_PATH, { ts: nowIso(), type: 'child_organ_spawn', ok: true, child_id: childId, parent_id: parentId, envelope, ttl_hours: ttlHours });
  process.stdout.write(`${JSON.stringify({ ok: true, type: 'child_organ_spawn', child: childRecord })}\n`);
}

function cmdRun(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : POLICY_PATH);
  const state = loadState();
  const childId = normalizeToken(args.child_id || args['child-id'] || '', 120);
  const child = childId ? state.children[childId] : null;
  if (!child) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'child_organ_run', error: 'child_not_found' })}\n`);
    process.exit(1);
  }
  const apply = toBool(args.apply, false);
  const reasons: string[] = [];
  if (policy.enabled !== true) reasons.push('runtime_disabled');
  if (policy.shadow_only === true && apply === true) reasons.push('shadow_only_mode');
  if (child.status === 'rolled_back') reasons.push('child_rolled_back');
  if (Date.parse(String(child.expires_at || '')) <= Date.now()) reasons.push('child_expired');
  const allowed = reasons.length === 0;

  const laneResults = [];
  let failedLane = null;
  if (allowed) {
    for (const [laneName, laneCfg] of Object.entries(policy.lanes || {})) {
      if (!laneCfg || laneCfg.enabled !== true) continue;
      const result = laneCall(String(laneName), laneCfg as AnyObj, child);
      laneResults.push(result);
      if (!result.ok) {
        failedLane = result;
        break;
      }
    }
  }

  const runId = normalizeToken(`run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`, 120);
  const rollbackReceiptId = failedLane
    ? `rb_${sha(`${child.child_id}|${child.parent_id}|${runId}|${failedLane.lane}`).slice(0, 18)}`
    : null;
  const ok = allowed && !failedLane;
  const runRecord = {
    run_id: runId,
    ts: nowIso(),
    child_id: child.child_id,
    parent_id: child.parent_id,
    apply,
    allowed,
    reasons,
    ok,
    lane_results: laneResults,
    rollback_receipt_id: rollbackReceiptId
  };

  child.status = ok ? 'active' : (failedLane ? 'rollback_pending' : child.status);
  child.last_run_id = runId;
  if (failedLane) {
    child.rollback = {
      pending: true,
      rollback_receipt_id: rollbackReceiptId,
      reason: policy.rollback.rollback_reason_default || 'child_lane_failure',
      failed_lane: failedLane.lane,
      ts: nowIso()
    };
  }
  state.children[child.child_id] = child;
  state.runs[runId] = runRecord;
  saveState(state);
  appendJsonl(RECEIPTS_PATH, { ts: nowIso(), type: 'child_organ_run', ...runRecord });
  process.stdout.write(`${JSON.stringify({ ok, type: 'child_organ_run', run: runRecord, child: state.children[child.child_id] })}\n`);
  if (!ok) process.exit(1);
}

function cmdRollback(args: AnyObj) {
  const state = loadState();
  const childId = normalizeToken(args.child_id || args['child-id'] || '', 120);
  const child = childId ? state.children[childId] : null;
  if (!child) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'child_organ_rollback', error: 'child_not_found' })}\n`);
    process.exit(1);
  }
  const previousStatus = cleanText(child.status || 'unknown', 60) || 'unknown';
  const reason = cleanText(args.reason || 'manual_rollback', 220) || 'manual_rollback';
  const rollbackId = `rb_${sha(`${child.child_id}|${reason}|${Date.now()}`).slice(0, 18)}`;
  child.status = 'rolled_back';
  child.rollback = {
    pending: false,
    rollback_receipt_id: rollbackId,
    reason,
    previous_status: previousStatus,
    ts: nowIso()
  };
  state.children[child.child_id] = child;
  saveState(state);
  appendJsonl(RECEIPTS_PATH, {
    ts: nowIso(),
    type: 'child_organ_rollback',
    ok: true,
    child_id: child.child_id,
    rollback_receipt_id: rollbackId,
    reason,
    previous_status: previousStatus
  });
  process.stdout.write(`${JSON.stringify({ ok: true, type: 'child_organ_rollback', child })}\n`);
}

function cmdStatus(args: AnyObj) {
  const state = loadState();
  const childId = normalizeToken(args.child_id || args['child-id'] || '', 120);
  const out = {
    ok: true,
    type: 'child_organ_status',
    ts: nowIso(),
    child_id: childId || null,
    child: childId ? (state.children[childId] || null) : null,
    children: childId ? undefined : state.children,
    runs: childId ? undefined : state.runs
  };
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = cleanText(args._[0] || '', 32);
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'spawn') return cmdSpawn(args);
  if (cmd === 'run') return cmdRun(args);
  if (cmd === 'rollback') return cmdRollback(args);
  if (cmd === 'status') return cmdStatus(args);
  usage();
  process.exit(2);
}

if (require.main === module) {
  main();
}
