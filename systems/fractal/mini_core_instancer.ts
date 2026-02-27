#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const POLICY_PATH = process.env.MINI_CORE_POLICY_PATH
  ? path.resolve(process.env.MINI_CORE_POLICY_PATH)
  : path.join(ROOT, 'config', 'mini_core_instancer_policy.json');
const STATE_PATH = process.env.MINI_CORE_STATE_PATH
  ? path.resolve(process.env.MINI_CORE_STATE_PATH)
  : path.join(ROOT, 'state', 'fractal', 'mini_core_instancer', 'state.json');
const RECEIPTS_PATH = process.env.MINI_CORE_RECEIPTS_PATH
  ? path.resolve(process.env.MINI_CORE_RECEIPTS_PATH)
  : path.join(ROOT, 'state', 'fractal', 'mini_core_instancer', 'receipts.jsonl');

function nowIso() {
  return new Date().toISOString();
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

function clampInt(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (const token of argv) {
    if (!token.startsWith('--')) {
      out._.push(token);
      continue;
    }
    const idx = token.indexOf('=');
    if (idx < 0) out[token.slice(2)] = true;
    else out[token.slice(2, idx)] = token.slice(idx + 1);
  }
  return out;
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

function hash10(seed: string) {
  return crypto.createHash('sha256').update(seed).digest('hex').slice(0, 10);
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    max_depth: 4,
    max_instances: 32,
    namespace_root: 'state/fractal/mini_core_instancer/namespaces',
    envelopes: {
      token_cap_default: 400,
      token_cap_max: 5000,
      memory_mb_default: 256,
      memory_mb_max: 4096
    },
    governance: {
      inherited_clearance_default: 'L1',
      require_parent_contract: true
    }
  };
}

function loadPolicy(policyPath = POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const envelopes = raw.envelopes && typeof raw.envelopes === 'object' ? raw.envelopes : {};
  const governance = raw.governance && typeof raw.governance === 'object' ? raw.governance : {};
  return {
    version: cleanText(raw.version || base.version, 40) || base.version,
    enabled: raw.enabled !== false,
    max_depth: clampInt(raw.max_depth, 1, 16, base.max_depth),
    max_instances: clampInt(raw.max_instances, 1, 1024, base.max_instances),
    namespace_root: cleanText(raw.namespace_root || base.namespace_root, 260) || base.namespace_root,
    envelopes: {
      token_cap_default: clampInt(envelopes.token_cap_default, 1, 100000, base.envelopes.token_cap_default),
      token_cap_max: clampInt(envelopes.token_cap_max, 1, 1000000, base.envelopes.token_cap_max),
      memory_mb_default: clampInt(envelopes.memory_mb_default, 64, 1048576, base.envelopes.memory_mb_default),
      memory_mb_max: clampInt(envelopes.memory_mb_max, 64, 1048576, base.envelopes.memory_mb_max)
    },
    governance: {
      inherited_clearance_default: normalizeToken(
        governance.inherited_clearance_default || base.governance.inherited_clearance_default,
        40
      ) || base.governance.inherited_clearance_default,
      require_parent_contract: governance.require_parent_contract !== false
    }
  };
}

function defaultState() {
  return {
    schema_id: 'mini_core_instancer_state',
    schema_version: '1.0',
    updated_at: nowIso(),
    instances: {}
  };
}

function loadState() {
  const src = readJson(STATE_PATH, null);
  if (!src || typeof src !== 'object') return defaultState();
  return {
    schema_id: 'mini_core_instancer_state',
    schema_version: '1.0',
    updated_at: cleanText(src.updated_at || nowIso(), 64),
    instances: src.instances && typeof src.instances === 'object' ? src.instances : {}
  };
}

function saveState(state: AnyObj) {
  writeJsonAtomic(STATE_PATH, {
    schema_id: 'mini_core_instancer_state',
    schema_version: '1.0',
    updated_at: nowIso(),
    instances: state && state.instances && typeof state.instances === 'object' ? state.instances : {}
  });
}

function parseContracts(raw: unknown, fallbackClearance: string) {
  try {
    const parsed = JSON.parse(String(raw || '{}'));
    const row = parsed && typeof parsed === 'object' ? parsed : {};
    return {
      parent_contract_id: normalizeToken(row.parent_contract_id || '', 120) || null,
      inherited_clearance: normalizeToken(row.inherited_clearance || fallbackClearance, 40) || fallbackClearance,
      rollback_required: row.rollback_required !== false
    };
  } catch {
    return {
      parent_contract_id: null,
      inherited_clearance: fallbackClearance,
      rollback_required: true
    };
  }
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/fractal/mini_core_instancer.js instantiate --instance-id=<id> [--parent-instance-id=<id>] [--contracts-json={...}]');
  console.log('  node systems/fractal/mini_core_instancer.js tick --instance-id=<id>');
  console.log('  node systems/fractal/mini_core_instancer.js rollback --instance-id=<id> [--reason=...]');
  console.log('  node systems/fractal/mini_core_instancer.js status [--instance-id=<id>]');
}

function cmdInstantiate(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : POLICY_PATH);
  const state = loadState();
  if (policy.enabled !== true) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'mini_core_instantiate', error: 'instancer_disabled' })}\n`);
    process.exit(1);
  }
  const activeCount = Object.values(state.instances || {}).filter((row: any) => row && row.status !== 'rolled_back').length;
  if (activeCount >= policy.max_instances) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'mini_core_instantiate', error: 'max_instances_reached', max_instances: policy.max_instances })}\n`);
    process.exit(1);
  }

  const instanceId = normalizeToken(args.instance_id || args['instance-id'] || `core_${Date.now().toString(36)}`, 120);
  const parentId = normalizeToken(args.parent_instance_id || args['parent-instance-id'] || '', 120) || null;
  const parent = parentId ? state.instances[parentId] : null;
  if (parentId && !parent) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'mini_core_instantiate', error: 'parent_instance_not_found' })}\n`);
    process.exit(1);
  }
  const parentDepth = parent ? Number(parent.depth || 0) : 0;
  const depth = parentDepth + 1;
  if (depth > policy.max_depth) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'mini_core_instantiate', error: 'max_depth_exceeded', max_depth: policy.max_depth, requested_depth: depth })}\n`);
    process.exit(1);
  }

  const contracts = parseContracts(args.contracts_json || args['contracts-json'], policy.governance.inherited_clearance_default);
  if (policy.governance.require_parent_contract === true && depth > 1 && !contracts.parent_contract_id) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'mini_core_instantiate', error: 'parent_contract_required' })}\n`);
    process.exit(1);
  }

  const namespaceRoot = path.resolve(ROOT, policy.namespace_root);
  const namespacePath = path.join(namespaceRoot, instanceId);
  ensureDir(namespacePath);
  const envelope = {
    token_cap: clampInt(args.token_cap || args['token-cap'], 1, policy.envelopes.token_cap_max, policy.envelopes.token_cap_default),
    memory_mb: clampInt(args.memory_mb || args['memory-mb'], 64, policy.envelopes.memory_mb_max, policy.envelopes.memory_mb_default)
  };

  const ts = nowIso();
  const record = {
    instance_id: instanceId,
    parent_instance_id: parentId,
    depth,
    status: 'active',
    created_at: ts,
    namespace_path: path.relative(ROOT, namespacePath).replace(/\\/g, '/'),
    contracts,
    envelope,
    lineage_hash: `line_${hash10(`${parentId || 'root'}|${instanceId}|${depth}`)}`
  };
  state.instances[instanceId] = record;
  saveState(state);
  appendJsonl(RECEIPTS_PATH, { ts, type: 'mini_core_instantiate', ok: true, instance_id: instanceId, parent_instance_id: parentId, depth, lineage_hash: record.lineage_hash });
  process.stdout.write(`${JSON.stringify({ ok: true, type: 'mini_core_instantiate', record })}\n`);
}

function cmdTick(args: AnyObj) {
  const state = loadState();
  const instanceId = normalizeToken(args.instance_id || args['instance-id'] || '', 120);
  const row = instanceId ? state.instances[instanceId] : null;
  if (!row) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'mini_core_tick', error: 'instance_not_found' })}\n`);
    process.exit(1);
  }
  if (row.status === 'rolled_back') {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'mini_core_tick', error: 'instance_rolled_back' })}\n`);
    process.exit(1);
  }
  const ts = nowIso();
  const governanceReceipt = {
    contract_id: row.contracts && row.contracts.parent_contract_id || null,
    inherited_clearance: row.contracts && row.contracts.inherited_clearance || null,
    lineage_hash: row.lineage_hash
  };
  row.last_tick_at = ts;
  state.instances[instanceId] = row;
  saveState(state);
  appendJsonl(RECEIPTS_PATH, { ts, type: 'mini_core_tick', ok: true, instance_id: instanceId, governance: governanceReceipt });
  process.stdout.write(`${JSON.stringify({ ok: true, type: 'mini_core_tick', instance_id: instanceId, governance: governanceReceipt })}\n`);
}

function cmdRollback(args: AnyObj) {
  const state = loadState();
  const instanceId = normalizeToken(args.instance_id || args['instance-id'] || '', 120);
  const row = instanceId ? state.instances[instanceId] : null;
  if (!row) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'mini_core_rollback', error: 'instance_not_found' })}\n`);
    process.exit(1);
  }
  const reason = cleanText(args.reason || 'manual_rollback', 220) || 'manual_rollback';
  row.status = 'rolled_back';
  row.rollback = {
    ts: nowIso(),
    reason,
    rollback_receipt_id: `rb_${hash10(`${instanceId}|${reason}|${Date.now()}`)}`
  };
  state.instances[instanceId] = row;
  saveState(state);
  appendJsonl(RECEIPTS_PATH, { ts: nowIso(), type: 'mini_core_rollback', ok: true, instance_id: instanceId, reason, rollback_receipt_id: row.rollback.rollback_receipt_id });
  process.stdout.write(`${JSON.stringify({ ok: true, type: 'mini_core_rollback', record: row })}\n`);
}

function cmdStatus(args: AnyObj) {
  const state = loadState();
  const instanceId = normalizeToken(args.instance_id || args['instance-id'] || '', 120);
  const out = {
    ok: true,
    type: 'mini_core_status',
    ts: nowIso(),
    instance_id: instanceId || null,
    record: instanceId ? (state.instances[instanceId] || null) : null,
    instances: instanceId ? undefined : state.instances
  };
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || '', 40);
  if (!cmd || cmd === 'help' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'instantiate') return cmdInstantiate(args);
  if (cmd === 'tick') return cmdTick(args);
  if (cmd === 'rollback') return cmdRollback(args);
  if (cmd === 'status') return cmdStatus(args);
  usage();
  process.exit(2);
}

if (require.main === module) {
  main();
}

