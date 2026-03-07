#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-191 helper surface for `protheus-top --mobile`.
 */

const path = require('path');
const {
  ROOT,
  nowIso,
  readJson,
  emit
} = require('../../lib/queued_backlog_runtime');

const DEFAULT_POLICY_PATH = process.env.MOBILE_OPS_TOP_POLICY_PATH
  ? path.resolve(process.env.MOBILE_OPS_TOP_POLICY_PATH)
  : path.join(ROOT, 'config', 'mobile_ops_top_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/edge/mobile_ops_top.js status');
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const defaults = {
    version: '1.0',
    enabled: true,
    paths: {
      edge_latest_path: 'state/edge/protheus_edge/latest.json',
      edge_state_path: 'state/edge/protheus_edge/session_state.json',
      lifecycle_latest_path: 'state/edge/mobile_lifecycle/latest.json',
      lifecycle_state_path: 'state/edge/mobile_lifecycle/state.json',
      swarm_latest_path: 'state/spawn/mobile_edge_swarm_bridge/latest.json'
    }
  };
  const resolveMaybeAbs = (input: unknown, fallbackRel: string) => {
    const txt = String(input || fallbackRel);
    if (path.isAbsolute(txt)) return txt;
    return path.join(ROOT, txt);
  };
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  const merged = {
    ...defaults,
    ...raw,
    paths: {
      ...defaults.paths,
      ...paths
    }
  };
  return {
    version: String(merged.version || defaults.version),
    enabled: merged.enabled !== false,
    policy_path: path.resolve(policyPath),
    paths: {
      edge_latest_path: resolveMaybeAbs(merged.paths.edge_latest_path, defaults.paths.edge_latest_path),
      edge_state_path: resolveMaybeAbs(merged.paths.edge_state_path, defaults.paths.edge_state_path),
      lifecycle_latest_path: resolveMaybeAbs(merged.paths.lifecycle_latest_path, defaults.paths.lifecycle_latest_path),
      lifecycle_state_path: resolveMaybeAbs(merged.paths.lifecycle_state_path, defaults.paths.lifecycle_state_path),
      swarm_latest_path: resolveMaybeAbs(merged.paths.swarm_latest_path, defaults.paths.swarm_latest_path)
    }
  };
}

function status(policy: any) {
  const edgeLatest = readJson(policy.paths.edge_latest_path, {});
  const edgeState = readJson(policy.paths.edge_state_path, {});
  const lifecycleLatest = readJson(policy.paths.lifecycle_latest_path, {});
  const lifecycleState = readJson(policy.paths.lifecycle_state_path, {});
  const swarmLatest = readJson(policy.paths.swarm_latest_path, {});

  return {
    ok: true,
    type: 'protheus_mobile_top',
    ts: nowIso(),
    edge: {
      active: edgeState.active === true,
      owner_id: edgeState.owner_id || null,
      profile: edgeState.profile || null,
      online: edgeState.online === true,
      last_event: edgeLatest.event || null,
      last_sync_at: edgeState.last_sync_at || null
    },
    lifecycle: {
      action: lifecycleState.action || null,
      mode: lifecycleState.mode || null,
      battery_pct: lifecycleState.battery_pct,
      thermal_c: lifecycleState.thermal_c,
      doze_mode: lifecycleState.doze_mode === true,
      survives_72h_target: lifecycleState.survives_72h_target === true,
      last_event: lifecycleLatest.event || null
    },
    swarm: {
      enrolled_nodes: Number(swarmLatest.enrolled_nodes || 0),
      active_nodes: Number(swarmLatest.active_nodes || 0),
      quarantined_nodes: Number(swarmLatest.quarantined_nodes || 0)
    }
  };
}

function main() {
  const cmd = String(process.argv[2] || 'status').trim().toLowerCase();
  if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
    usage();
    return;
  }
  const policy = loadPolicy();
  if (!policy.enabled) emit({ ok: false, error: 'mobile_ops_top_disabled' }, 1);
  if (cmd === 'status') emit(status(policy));
  usage();
  process.exit(1);
}

main();
