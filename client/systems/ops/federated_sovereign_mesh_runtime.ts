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
  clampNumber,
  readJson,
  writeJsonAtomic,
  appendJsonl,
  resolvePath,
  stableHash,
  emit
} = require('../../lib/queued_backlog_runtime');

const DEFAULT_POLICY_PATH = process.env.FEDERATED_SOVEREIGN_MESH_RUNTIME_POLICY_PATH
  ? path.resolve(process.env.FEDERATED_SOVEREIGN_MESH_RUNTIME_POLICY_PATH)
  : path.join(ROOT, 'config', 'federated_sovereign_mesh_runtime_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/federated_sovereign_mesh_runtime.js join --node-id=<id> [--trust=<0..1>] [--capacity=<n>] [--attested=1|0] [--apply=0|1] [--policy=<path>]');
  console.log('  node systems/ops/federated_sovereign_mesh_runtime.js elect [--apply=0|1] [--policy=<path>]');
  console.log('  node systems/ops/federated_sovereign_mesh_runtime.js replicate --stream=<id> [--payload=<txt>] [--apply=0|1] [--policy=<path>]');
  console.log('  node systems/ops/federated_sovereign_mesh_runtime.js partition-drill [--apply=0|1] [--policy=<path>]');
  console.log('  node systems/ops/federated_sovereign_mesh_runtime.js status [--policy=<path>]');
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    shadow_only: true,
    require_attested_peers: true,
    replication_quorum: 2,
    min_trust_score: 0.65,
    paths: {
      state_path: 'state/ops/federated_sovereign_mesh_runtime/state.json',
      latest_path: 'state/ops/federated_sovereign_mesh_runtime/latest.json',
      receipts_path: 'state/ops/federated_sovereign_mesh_runtime/receipts.jsonl',
      replication_log_path: 'state/ops/federated_sovereign_mesh_runtime/replication_log.jsonl',
      partition_drills_path: 'state/ops/federated_sovereign_mesh_runtime/partition_drills.jsonl'
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
    require_attested_peers: toBool(raw.require_attested_peers, true),
    replication_quorum: clampInt(raw.replication_quorum, 1, 64, base.replication_quorum),
    min_trust_score: clampNumber(raw.min_trust_score, 0, 1, base.min_trust_score),
    paths: {
      state_path: resolvePath(paths.state_path, base.paths.state_path),
      latest_path: resolvePath(paths.latest_path, base.paths.latest_path),
      receipts_path: resolvePath(paths.receipts_path, base.paths.receipts_path),
      replication_log_path: resolvePath(paths.replication_log_path, base.paths.replication_log_path),
      partition_drills_path: resolvePath(paths.partition_drills_path, base.paths.partition_drills_path)
    }
  };
}

function baseState() {
  return {
    schema_id: 'federated_sovereign_mesh_runtime_state',
    schema_version: '1.0',
    updated_at: nowIso(),
    leader_node_id: '',
    term: 0,
    nodes: [],
    replication_streams: {},
    last_partition_drill: null
  };
}

function loadState(policy) {
  const raw = readJson(policy.paths.state_path, null);
  const base = baseState();
  if (!raw || typeof raw !== 'object') return base;
  return {
    ...base,
    ...raw,
    nodes: Array.isArray(raw.nodes) ? raw.nodes : [],
    replication_streams: raw.replication_streams && typeof raw.replication_streams === 'object' ? raw.replication_streams : {}
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

function normalizeNode(row, policy) {
  const nodeId = normalizeToken(row.node_id || row.nodeId || '', 120);
  const trust = clampNumber(row.trust_score, 0, 1, 0.75);
  const capacity = clampInt(row.capacity_score, 1, 10000, 100);
  return {
    node_id: nodeId,
    attested: toBool(row.attested, true),
    trust_score: trust,
    capacity_score: capacity,
    role: cleanText(row.role || 'worker', 40),
    heartbeat_ts: cleanText(row.heartbeat_ts || nowIso(), 64),
    eligible: (!policy.require_attested_peers || toBool(row.attested, true)) && trust >= policy.min_trust_score
  };
}

function chooseLeader(nodes) {
  const ranked = nodes
    .filter((row) => row.eligible === true)
    .slice()
    .sort((a, b) => {
      if (Number(b.capacity_score || 0) !== Number(a.capacity_score || 0)) {
        return Number(b.capacity_score || 0) - Number(a.capacity_score || 0);
      }
      if (Number(b.trust_score || 0) !== Number(a.trust_score || 0)) {
        return Number(b.trust_score || 0) - Number(a.trust_score || 0);
      }
      return String(a.node_id || '').localeCompare(String(b.node_id || ''));
    });
  return ranked[0] || null;
}

function cmdJoin(args, policy) {
  const apply = toBool(args.apply, false);
  const nodeId = normalizeToken(args['node-id'] || args.node_id || '', 120);
  if (!nodeId) return { ok: false, type: 'federated_mesh_join', error: 'node_id_required' };

  const state = loadState(policy);
  const node = normalizeNode({
    node_id: nodeId,
    trust_score: args.trust,
    capacity_score: args.capacity,
    attested: args.attested,
    role: args.role,
    heartbeat_ts: nowIso()
  }, policy);

  const nextNodes = state.nodes.filter((row) => String(row.node_id) !== nodeId);
  nextNodes.push(node);

  let next = state;
  if (apply) {
    next = saveState(policy, { ...state, nodes: nextNodes });
  }

  return writeReceipt(policy, {
    type: 'federated_mesh_join',
    apply,
    node,
    node_count: nextNodes.length,
    eligible_nodes: nextNodes.filter((row) => row.eligible === true).length
  });
}

function cmdElect(args, policy) {
  const apply = toBool(args.apply, false);
  const state = loadState(policy);
  const normalized = state.nodes.map((row) => normalizeNode(row, policy));
  const leader = chooseLeader(normalized);
  const quorum = normalized.filter((row) => row.eligible === true).length >= policy.replication_quorum;

  let next = state;
  if (apply) {
    next = saveState(policy, {
      ...state,
      nodes: normalized,
      leader_node_id: leader ? leader.node_id : '',
      term: Number(state.term || 0) + 1
    });
  }

  return writeReceipt(policy, {
    type: 'federated_mesh_elect',
    apply,
    quorum,
    replication_quorum: policy.replication_quorum,
    leader_node_id: leader ? leader.node_id : '',
    term: apply ? next.term : Number(state.term || 0),
    eligible_nodes: normalized.filter((row) => row.eligible === true).length
  });
}

function cmdReplicate(args, policy) {
  const apply = toBool(args.apply, false);
  const stream = normalizeToken(args.stream || 'default', 80) || 'default';
  const payload = cleanText(args.payload || `${stream}:${nowIso()}`, 400);
  const state = loadState(policy);
  const normalized = state.nodes.map((row) => normalizeNode(row, policy));
  const eligible = normalized.filter((row) => row.eligible === true);
  const acks = eligible.slice(0, Math.max(0, policy.replication_quorum - 1)).map((row) => row.node_id);
  const digest = stableHash(`${stream}|${payload}|${state.term || 0}`, 24);

  const row = {
    ts: nowIso(),
    stream,
    digest,
    payload,
    leader_node_id: String(state.leader_node_id || ''),
    ack_nodes: acks,
    quorum_met: acks.length + 1 >= policy.replication_quorum
  };

  if (apply) {
    const next = {
      ...state,
      replication_streams: {
        ...state.replication_streams,
        [stream]: {
          digest,
          payload_hash: stableHash(payload, 24),
          replicated_at: row.ts,
          ack_nodes: acks
        }
      }
    };
    saveState(policy, next);
    appendJsonl(policy.paths.replication_log_path, row);
  }

  return writeReceipt(policy, {
    type: 'federated_mesh_replicate',
    apply,
    stream,
    digest,
    quorum_met: row.quorum_met,
    ack_count: acks.length,
    replication_quorum: policy.replication_quorum
  });
}

function cmdPartitionDrill(args, policy) {
  const apply = toBool(args.apply, false);
  const state = loadState(policy);
  const normalized = state.nodes.map((row) => normalizeNode(row, policy));
  const leader = chooseLeader(normalized);
  const islandA = normalized.filter((_, idx) => idx % 2 === 0).map((row) => row.node_id);
  const islandB = normalized.filter((_, idx) => idx % 2 === 1).map((row) => row.node_id);

  const drill = {
    ts: nowIso(),
    leader_before: String(state.leader_node_id || ''),
    leader_after: leader ? leader.node_id : '',
    island_a: islandA,
    island_b: islandB,
    partition_safe: islandA.length >= 1,
    degraded_mode: islandB.length === 0
  };

  if (apply) {
    appendJsonl(policy.paths.partition_drills_path, drill);
    saveState(policy, {
      ...state,
      nodes: normalized,
      leader_node_id: leader ? leader.node_id : String(state.leader_node_id || ''),
      last_partition_drill: drill
    });
  }

  return writeReceipt(policy, {
    type: 'federated_mesh_partition_drill',
    apply,
    partition_safe: drill.partition_safe,
    degraded_mode: drill.degraded_mode,
    island_a_size: islandA.length,
    island_b_size: islandB.length,
    leader_after: drill.leader_after
  });
}

function status(policy) {
  const state = loadState(policy);
  const normalized = state.nodes.map((row) => normalizeNode(row, policy));
  return {
    ok: true,
    type: 'federated_sovereign_mesh_runtime_status',
    shadow_only: policy.shadow_only,
    leader_node_id: String(state.leader_node_id || ''),
    term: Number(state.term || 0),
    node_count: normalized.length,
    eligible_nodes: normalized.filter((row) => row.eligible === true).length,
    replication_streams: state.replication_streams && typeof state.replication_streams === 'object'
      ? Object.keys(state.replication_streams).length
      : 0,
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
  if (!policy.enabled) emit({ ok: false, error: 'federated_sovereign_mesh_runtime_disabled' }, 1);

  if (cmd === 'join') emit(cmdJoin(args, policy));
  if (cmd === 'elect') emit(cmdElect(args, policy));
  if (cmd === 'replicate') emit(cmdReplicate(args, policy));
  if (cmd === 'partition-drill') emit(cmdPartitionDrill(args, policy));
  if (cmd === 'status') emit(status(policy));

  emit({ ok: false, error: `unknown_command:${cmd}` }, 1);
}

main();
