#!/usr/bin/env node
'use strict';
export {};

const path = require('path');
const {
  ROOT,
  nowIso,
  parseArgs,
  cleanText,
  normalizeToken,
  toBool,
  clampInt,
  readJson,
  writeJsonAtomic,
  appendJsonl,
  resolvePath,
  emit
} = require('../../lib/queued_backlog_runtime');

const DEFAULT_POLICY_PATH = process.env.DEVICE_MESH_ADAPTIVE_RUNTIME_POLICY_PATH
  ? path.resolve(process.env.DEVICE_MESH_ADAPTIVE_RUNTIME_POLICY_PATH)
  : path.join(ROOT, 'config', 'device_mesh_adaptive_runtime_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/hardware/device_mesh_adaptive_runtime.js assign-roles [--apply=0|1] [--policy=<path>]');
  console.log('  node systems/hardware/device_mesh_adaptive_runtime.js heartbeat --node-id=<id> [--load=<0..100>] [--apply=0|1] [--policy=<path>]');
  console.log('  node systems/hardware/device_mesh_adaptive_runtime.js status [--policy=<path>]');
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    shadow_only: true,
    max_workers_per_mesh: 32,
    paths: {
      latest_path: 'state/hardware/device_mesh_adaptive_runtime/latest.json',
      receipts_path: 'state/hardware/device_mesh_adaptive_runtime/receipts.jsonl',
      state_path: 'state/hardware/device_mesh_adaptive_runtime/state.json',
      mesh_source_path: 'state/ops/federated_sovereign_mesh_runtime/state.json',
      surface_budget_path: 'state/hardware/surface_budget/latest.json'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  return {
    version: cleanText(raw.version || base.version, 32),
    enabled: toBool(raw.enabled, true),
    shadow_only: toBool(raw.shadow_only, true),
    max_workers_per_mesh: clampInt(raw.max_workers_per_mesh, 1, 256, base.max_workers_per_mesh),
    paths: {
      latest_path: resolvePath(paths.latest_path, base.paths.latest_path),
      receipts_path: resolvePath(paths.receipts_path, base.paths.receipts_path),
      state_path: resolvePath(paths.state_path, base.paths.state_path),
      mesh_source_path: resolvePath(paths.mesh_source_path, base.paths.mesh_source_path),
      surface_budget_path: resolvePath(paths.surface_budget_path, base.paths.surface_budget_path)
    }
  };
}

function loadState(policy) {
  const raw = readJson(policy.paths.state_path, {});
  return {
    schema_id: 'device_mesh_adaptive_runtime_state',
    schema_version: '1.0',
    updated_at: nowIso(),
    roles: raw.roles && typeof raw.roles === 'object' ? raw.roles : {},
    node_health: raw.node_health && typeof raw.node_health === 'object' ? raw.node_health : {}
  };
}

function saveState(policy, state) {
  const next = { ...state, updated_at: nowIso() };
  writeJsonAtomic(policy.paths.state_path, next);
  return next;
}

function writeReceipt(policy, row) {
  const out = { ts: nowIso(), ok: true, shadow_only: policy.shadow_only, ...row };
  writeJsonAtomic(policy.paths.latest_path, out);
  appendJsonl(policy.paths.receipts_path, out);
  return out;
}

function assignRoles(args, policy) {
  const apply = toBool(args.apply, false);
  const state = loadState(policy);
  const mesh = readJson(policy.paths.mesh_source_path, {});
  const nodes = Array.isArray(mesh.nodes) ? mesh.nodes : [];
  const leader = cleanText(mesh.leader_node_id || '', 120);

  const roles = {};
  let workers = 0;
  for (const row of nodes) {
    const id = normalizeToken(row.node_id || '', 120);
    if (!id) continue;
    if (id === leader) {
      roles[id] = 'leader';
      continue;
    }
    if (workers < policy.max_workers_per_mesh) {
      roles[id] = workers % 3 === 0 ? 'edge_executor' : (workers % 3 === 1 ? 'memory_cache' : 'sensor_router');
      workers += 1;
    } else {
      roles[id] = 'standby';
    }
  }

  if (apply) saveState(policy, { ...state, roles });

  return writeReceipt(policy, {
    type: 'device_mesh_assign_roles',
    apply,
    leader_node_id: leader,
    role_count: Object.keys(roles).length,
    worker_count: Object.values(roles).filter((r) => r !== 'leader' && r !== 'standby').length
  });
}

function heartbeat(args, policy) {
  const apply = toBool(args.apply, false);
  const nodeId = normalizeToken(args['node-id'] || args.node_id || '', 120);
  if (!nodeId) return { ok: false, type: 'device_mesh_heartbeat', error: 'node_id_required' };
  const load = clampInt(args.load, 0, 100, 0);
  const state = loadState(policy);
  const nodeHealth = {
    ...(state.node_health || {}),
    [nodeId]: {
      ts: nowIso(),
      load,
      status: load >= 90 ? 'hot' : (load >= 70 ? 'warm' : 'cool')
    }
  };
  if (apply) saveState(policy, { ...state, node_health: nodeHealth });
  return writeReceipt(policy, {
    type: 'device_mesh_heartbeat',
    apply,
    node_id: nodeId,
    load,
    status: nodeHealth[nodeId].status
  });
}

function status(policy) {
  const state = loadState(policy);
  const surface = readJson(policy.paths.surface_budget_path, {});
  const roles = state.roles && typeof state.roles === 'object' ? state.roles : {};
  return {
    ok: true,
    type: 'device_mesh_adaptive_runtime_status',
    shadow_only: policy.shadow_only,
    node_count: Object.keys(roles).length,
    role_counts: Object.values(roles).reduce((acc, role) => {
      const key = String(role || 'unknown');
      acc[key] = Number(acc[key] || 0) + 1;
      return acc;
    }, {}),
    runtime_mode: String(surface.mode || surface.active_mode || 'unknown'),
    latest: readJson(policy.paths.latest_path, {})
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || 'status', 80) || 'status';
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    usage();
    return;
  }
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  if (!policy.enabled) emit({ ok: false, error: 'device_mesh_adaptive_runtime_disabled' }, 1);

  if (cmd === 'assign-roles') emit(assignRoles(args, policy));
  if (cmd === 'heartbeat') emit(heartbeat(args, policy));
  if (cmd === 'status') emit(status(policy));

  emit({ ok: false, error: `unknown_command:${cmd}` }, 1);
}

main();
