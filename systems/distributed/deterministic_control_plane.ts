#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const POLICY_PATH = process.env.DETERMINISTIC_CONTROL_PLANE_POLICY_PATH
  ? path.resolve(process.env.DETERMINISTIC_CONTROL_PLANE_POLICY_PATH)
  : path.join(ROOT, 'config', 'deterministic_control_plane_policy.json');

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

function usage() {
  console.log('Usage:');
  console.log('  node systems/distributed/deterministic_control_plane.js run --nodes-json=<json|@file> [--apply=1|0]');
  console.log('  node systems/distributed/deterministic_control_plane.js status');
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

function writeJsonAtomic(filePath: string, payload: AnyObj) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function appendJsonl(filePath: string, row: AnyObj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function parseJsonArg(raw: unknown, fallback: any) {
  const text = cleanText(raw, 40000);
  if (!text) return fallback;
  const payloadText = text.startsWith('@')
    ? fs.readFileSync(path.resolve(text.slice(1)), 'utf8')
    : text;
  try {
    return JSON.parse(payloadText);
  } catch {
    return fallback;
  }
}

function defaultPolicy() {
  return {
    schema_id: 'deterministic_control_plane_policy',
    schema_version: '1.0',
    enabled: true,
    quorum_size: 2,
    local_trust_domain: 'primary',
    leader_strategy: 'lexicographic_node_id',
    state_path: 'state/distributed/control_plane/latest.json',
    history_path: 'state/distributed/control_plane/history.jsonl'
  };
}

function loadPolicy(policyPath = POLICY_PATH) {
  const src = readJson(policyPath, {});
  const base = defaultPolicy();
  return {
    schema_id: 'deterministic_control_plane_policy',
    schema_version: cleanText(src.schema_version || base.schema_version, 24) || base.schema_version,
    enabled: src.enabled !== false,
    quorum_size: Math.max(1, Math.min(128, Number(src.quorum_size || base.quorum_size) || base.quorum_size)),
    local_trust_domain: normalizeToken(src.local_trust_domain || base.local_trust_domain, 80) || base.local_trust_domain,
    leader_strategy: normalizeToken(src.leader_strategy || base.leader_strategy, 80) || base.leader_strategy,
    state_path: path.resolve(ROOT, cleanText(src.state_path || base.state_path, 320)),
    history_path: path.resolve(ROOT, cleanText(src.history_path || base.history_path, 320))
  };
}

function normalizeNode(row: AnyObj) {
  const nodeId = normalizeToken(row && row.node_id ? row.node_id : '', 80);
  if (!nodeId) return null;
  return {
    node_id: nodeId,
    online: toBool(row.online, true),
    attested: toBool(row.attested, false),
    partition_id: normalizeToken(row.partition_id || 'main', 80) || 'main',
    trust_domain: normalizeToken(row.trust_domain || 'unknown', 80) || 'unknown',
    priority: Number.isFinite(Number(row.priority)) ? Number(row.priority) : 0
  };
}

function chooseLeader(nodes: AnyObj[], strategy: string) {
  if (!nodes.length) return null;
  const sorted = nodes.slice(0).sort((a, b) => {
    if (strategy === 'priority_then_lexicographic') {
      const ap = Number(a.priority || 0);
      const bp = Number(b.priority || 0);
      if (bp !== ap) return bp - ap;
    }
    return String(a.node_id || '').localeCompare(String(b.node_id || ''));
  });
  return sorted[0];
}

function runPlane(policy: AnyObj, nodesInput: AnyObj[]) {
  const nodes = (Array.isArray(nodesInput) ? nodesInput : [])
    .map((row) => normalizeNode(row))
    .filter(Boolean);
  const trustDomain = policy.local_trust_domain;
  const events: AnyObj[] = [];
  const localNodes = nodes.filter((row) => row.trust_domain === trustDomain);
  const foreignNodes = nodes.filter((row) => row.trust_domain !== trustDomain);
  if (foreignNodes.length) {
    events.push({
      type: 'foreign_instances_observed',
      foreign_count: foreignNodes.length,
      node_ids: foreignNodes.map((row) => row.node_id)
    });
  }

  const partitionMap: Record<string, AnyObj[]> = {};
  for (const row of localNodes) {
    if (!row.online || !row.attested) continue;
    if (!partitionMap[row.partition_id]) partitionMap[row.partition_id] = [];
    partitionMap[row.partition_id].push(row);
  }
  const partitions = Object.keys(partitionMap).sort();
  let activePartitionId = null;
  let activeNodes: AnyObj[] = [];
  for (const pid of partitions) {
    const rows = partitionMap[pid];
    if (rows.length > activeNodes.length) {
      activePartitionId = pid;
      activeNodes = rows;
      continue;
    }
    if (rows.length === activeNodes.length && rows.length > 0 && pid < String(activePartitionId || 'zzz')) {
      activePartitionId = pid;
      activeNodes = rows;
    }
  }

  const quorumMet = activeNodes.length >= Number(policy.quorum_size || 1);
  if (!quorumMet) {
    events.push({
      type: 'partition_no_quorum',
      active_partition_id: activePartitionId,
      active_count: activeNodes.length,
      quorum_size: policy.quorum_size
    });
  }
  const leader = quorumMet ? chooseLeader(activeNodes, policy.leader_strategy) : null;

  return {
    schema_id: 'deterministic_control_plane_snapshot',
    schema_version: '1.0',
    ts: nowIso(),
    ok: true,
    trust_domain: trustDomain,
    quorum_size: policy.quorum_size,
    local_node_count: localNodes.length,
    foreign_node_count: foreignNodes.length,
    active_partition_id: activePartitionId,
    quorum_met: quorumMet,
    leader_node_id: leader ? leader.node_id : null,
    node_view: nodes,
    events
  };
}

function cmdRun(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : POLICY_PATH);
  if (!policy.enabled) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'deterministic_control_plane', error: 'policy_disabled' })}\n`);
    process.exit(1);
  }
  const nodes = parseJsonArg(args.nodes_json || args['nodes-json'] || '', null);
  if (!Array.isArray(nodes)) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'deterministic_control_plane', error: 'nodes_json_array_required' })}\n`);
    process.exit(2);
  }
  const apply = toBool(args.apply, true);
  const prev = readJson(policy.state_path, {});
  const prevLeader = cleanText(prev.leader_node_id || '', 80) || null;
  const snapshot = runPlane(policy, nodes);
  if (prevLeader !== snapshot.leader_node_id) {
    snapshot.events.push({
      type: 'leader_failover',
      from_leader: prevLeader,
      to_leader: snapshot.leader_node_id
    });
  }
  if (snapshot.leader_node_id) {
    snapshot.events.push({
      type: 'leader_elected',
      leader_node_id: snapshot.leader_node_id,
      partition_id: snapshot.active_partition_id
    });
  }
  snapshot.apply = apply;
  if (apply) {
    writeJsonAtomic(policy.state_path, snapshot);
    appendJsonl(policy.history_path, snapshot);
  }
  process.stdout.write(`${JSON.stringify(snapshot)}\n`);
}

function cmdStatus(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : POLICY_PATH);
  if (!fs.existsSync(policy.state_path)) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      type: 'deterministic_control_plane_status',
      error: 'status_not_found',
      state_path: path.relative(ROOT, policy.state_path).replace(/\\/g, '/')
    })}\n`);
    process.exit(1);
  }
  process.stdout.write(`${fs.readFileSync(policy.state_path, 'utf8')}\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim().toLowerCase();
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'run') return cmdRun(args);
  if (cmd === 'status') return cmdStatus(args);
  usage();
  process.exit(2);
}

if (require.main === module) {
  main();
}
