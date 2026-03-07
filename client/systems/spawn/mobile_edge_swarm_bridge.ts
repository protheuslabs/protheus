#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-192
 * Mobile edge-node swarm enrollment bridge.
 *
 * Usage:
 *   node systems/spawn/mobile_edge_swarm_bridge.js configure --owner=<owner_id>
 *   node systems/spawn/mobile_edge_swarm_bridge.js enroll --owner=<owner_id> --device-id=<id> [--parent=<parent_id>] [--child=<child_id>] [--provenance-attested=1] [--apply=1]
 *   node systems/spawn/mobile_edge_swarm_bridge.js quarantine --owner=<owner_id> --device-id=<id> [--reason=<text>] [--apply=1]
 *   node systems/spawn/mobile_edge_swarm_bridge.js evict --owner=<owner_id> --device-id=<id> [--reason=<text>] [--apply=1]
 *   node systems/spawn/mobile_edge_swarm_bridge.js status [--owner=<owner_id>]
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  ROOT,
  nowIso,
  cleanText,
  normalizeToken,
  toBool,
  stableHash,
  readJson,
  writeJsonAtomic
} = require('../../lib/queued_backlog_runtime');
const { runStandardLane } = require('../../lib/upgrade_lane_runtime');

const POLICY_PATH = process.env.MOBILE_EDGE_SWARM_BRIDGE_POLICY_PATH
  ? path.resolve(process.env.MOBILE_EDGE_SWARM_BRIDGE_POLICY_PATH)
  : path.join(ROOT, 'config', 'mobile_edge_swarm_bridge_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/spawn/mobile_edge_swarm_bridge.js configure --owner=<owner_id>');
  console.log('  node systems/spawn/mobile_edge_swarm_bridge.js enroll --owner=<owner_id> --device-id=<id> [--parent=<parent_id>] [--child=<child_id>] [--provenance-attested=1] [--apply=1]');
  console.log('  node systems/spawn/mobile_edge_swarm_bridge.js quarantine --owner=<owner_id> --device-id=<id> [--reason=<text>] [--apply=1]');
  console.log('  node systems/spawn/mobile_edge_swarm_bridge.js evict --owner=<owner_id> --device-id=<id> [--reason=<text>] [--apply=1]');
  console.log('  node systems/spawn/mobile_edge_swarm_bridge.js status [--owner=<owner_id>]');
}

function ensureDir(filePath: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function readState(policy: any) {
  return readJson(policy.paths.enrollment_state_path, {
    schema_id: 'mobile_edge_swarm_bridge_state',
    schema_version: '1.0',
    nodes: []
  });
}

function writeState(policy: any, state: any) {
  ensureDir(policy.paths.enrollment_state_path);
  writeJsonAtomic(policy.paths.enrollment_state_path, state);
}

function rel(absPath: string) {
  return path.relative(ROOT, absPath).replace(/\\/g, '/');
}

function lineagePreview(policy: any, ownerId: string, parentId: string, childId: string, apply: boolean) {
  const lineageScript = path.join(ROOT, 'systems', 'spawn', 'seed_spawn_lineage.js');
  const args = [
    lineageScript,
    'preview',
    `--owner=${ownerId}`,
    `--parent=${parentId}`,
    `--child=${childId}`,
    '--profile=seed_spawn',
    `--apply=${apply ? '1' : '0'}`
  ];
  if (policy.lineage_policy_path) args.push(`--policy=${policy.lineage_policy_path}`);
  const proc = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', timeout: 20000 });
  let payload = null;
  const txt = String(proc.stdout || '').trim();
  if (txt) {
    const lines = txt.split('\n');
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      try {
        payload = JSON.parse(lines[i]);
        break;
      } catch {}
    }
  }
  return {
    ok: Number(proc.status || 0) === 0,
    status: Number(proc.status || 0),
    payload,
    stderr: cleanText(proc.stderr || '', 300)
  };
}

function summarizeNodes(nodes: any[]) {
  const list = Array.isArray(nodes) ? nodes : [];
  return {
    enrolled_nodes: list.length,
    active_nodes: list.filter((row) => row.status === 'active').length,
    quarantined_nodes: list.filter((row) => row.status === 'quarantined').length,
    evicted_nodes: list.filter((row) => row.status === 'evicted').length
  };
}

runStandardLane({
  lane_id: 'V3-RACE-192',
  script_rel: 'systems/spawn/mobile_edge_swarm_bridge.js',
  policy_path: POLICY_PATH,
  stream: 'spawn.mobile_edge',
  paths: {
    memory_dir: 'memory/edge/swarm',
    adaptive_index_path: 'adaptive/edge/swarm/index.json',
    events_path: 'state/spawn/mobile_edge_swarm_bridge/events.jsonl',
    latest_path: 'state/spawn/mobile_edge_swarm_bridge/latest.json',
    receipts_path: 'state/spawn/mobile_edge_swarm_bridge/receipts.jsonl',
    enrollment_state_path: 'state/spawn/mobile_edge_swarm_bridge/state.json'
  },
  usage,
  handlers: {
    enroll(policy: any, args: any, ctx: any) {
      const ownerId = normalizeToken(args.owner || args.owner_id, 120);
      if (!ownerId) return { ok: false, error: 'missing_owner' };
      const deviceId = normalizeToken(args['device-id'] || args.device_id, 120);
      if (!deviceId) return { ok: false, error: 'missing_device_id' };
      const apply = toBool(args.apply, true);
      const provenanceAttested = toBool(args['provenance-attested'] != null ? args['provenance-attested'] : args.provenance_attested, false);
      if (policy.require_provenance_attestation && !provenanceAttested) {
        return { ok: false, error: 'provenance_attestation_required', owner_id: ownerId, device_id: deviceId };
      }
      const parentId = normalizeToken(args.parent || args.parent_id || ownerId, 120) || ownerId;
      const childId = normalizeToken(args.child || args.child_id || `edge_${deviceId}`, 120) || `edge_${deviceId}`;
      const lineage = lineagePreview(policy, ownerId, parentId, childId, apply);
      if (!lineage.ok) {
        return {
          ok: false,
          error: 'seed_spawn_lineage_preview_failed',
          owner_id: ownerId,
          device_id: deviceId,
          lineage_status: lineage.status,
          lineage_stderr: lineage.stderr
        };
      }

      const lineageContract = lineage.payload && lineage.payload.lineage_contract ? lineage.payload.lineage_contract : null;
      const state = readState(policy);
      const nodes = Array.isArray(state.nodes) ? state.nodes.filter((row: any) => String(row.device_id) !== deviceId) : [];
      const nodeRow = {
        device_id: deviceId,
        owner_id: ownerId,
        parent_id: parentId,
        child_id: childId,
        status: 'active',
        provenance_attested: provenanceAttested,
        provenance_hash: stableHash(`${deviceId}|${ownerId}|${parentId}|${childId}`, 24),
        lineage_contract_id: lineageContract && lineageContract.lineage_contract_id ? lineageContract.lineage_contract_id : null,
        inherited_directives: lineageContract && Array.isArray(lineageContract.inherited_directives) ? lineageContract.inherited_directives : [],
        inherited_contract_refs: lineageContract && Array.isArray(lineageContract.inherited_contract_refs) ? lineageContract.inherited_contract_refs : [],
        enrolled_at: nowIso(),
        updated_at: nowIso()
      };
      nodes.push(nodeRow);
      const nextState = {
        ...state,
        nodes
      };
      if (apply) writeState(policy, nextState);

      const summary = summarizeNodes(nodes);
      return ctx.cmdRecord(policy, {
        ...args,
        event: 'mobile_edge_node_enrolled',
        apply,
        payload_json: JSON.stringify({
          owner_id: ownerId,
          node: nodeRow,
          lineage_contract_id: nodeRow.lineage_contract_id,
          summary,
          enrollment_state_path: rel(policy.paths.enrollment_state_path)
        })
      });
    },

    quarantine(policy: any, args: any, ctx: any) {
      const ownerId = normalizeToken(args.owner || args.owner_id, 120);
      const deviceId = normalizeToken(args['device-id'] || args.device_id, 120);
      if (!ownerId || !deviceId) return { ok: false, error: 'missing_owner_or_device_id' };
      const apply = toBool(args.apply, true);
      const reason = cleanText(args.reason || 'risk_signal', 240) || 'risk_signal';

      const state = readState(policy);
      const nodes = Array.isArray(state.nodes) ? state.nodes : [];
      const idx = nodes.findIndex((row: any) => String(row.device_id) === deviceId);
      if (idx < 0) return { ok: false, error: 'node_not_found', device_id: deviceId };
      const node = { ...nodes[idx], status: 'quarantined', quarantine_reason: reason, updated_at: nowIso() };
      nodes[idx] = node;
      if (apply) writeState(policy, { ...state, nodes });

      return ctx.cmdRecord(policy, {
        ...args,
        event: 'mobile_edge_node_quarantined',
        apply,
        payload_json: JSON.stringify({ owner_id: ownerId, node, summary: summarizeNodes(nodes), enrollment_state_path: rel(policy.paths.enrollment_state_path) })
      });
    },

    evict(policy: any, args: any, ctx: any) {
      const ownerId = normalizeToken(args.owner || args.owner_id, 120);
      const deviceId = normalizeToken(args['device-id'] || args.device_id, 120);
      if (!ownerId || !deviceId) return { ok: false, error: 'missing_owner_or_device_id' };
      const apply = toBool(args.apply, true);
      const reason = cleanText(args.reason || 'operator_evict', 240) || 'operator_evict';

      const state = readState(policy);
      const nodes = Array.isArray(state.nodes) ? state.nodes : [];
      const idx = nodes.findIndex((row: any) => String(row.device_id) === deviceId);
      if (idx < 0) return { ok: false, error: 'node_not_found', device_id: deviceId };
      const node = { ...nodes[idx], status: 'evicted', evict_reason: reason, updated_at: nowIso() };
      nodes[idx] = node;
      if (apply) writeState(policy, { ...state, nodes });

      return ctx.cmdRecord(policy, {
        ...args,
        event: 'mobile_edge_node_evicted',
        apply,
        payload_json: JSON.stringify({ owner_id: ownerId, node, summary: summarizeNodes(nodes), enrollment_state_path: rel(policy.paths.enrollment_state_path) })
      });
    },

    status(policy: any, args: any, ctx: any) {
      const base = ctx.cmdStatus(policy, args);
      const state = readState(policy);
      const nodes = Array.isArray(state.nodes) ? state.nodes : [];
      return {
        ...base,
        ...summarizeNodes(nodes),
        nodes,
        artifacts: {
          ...base.artifacts,
          enrollment_state_path: rel(policy.paths.enrollment_state_path)
        }
      };
    }
  }
});
