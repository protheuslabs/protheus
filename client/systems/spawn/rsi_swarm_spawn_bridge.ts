#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-182
 * RSI-to-swarm spawn bridge with inherited governance and provenance gate.
 */

const path = require('path');
const { spawnSync } = require('child_process');
const {
  ROOT,
  cleanText,
  normalizeToken,
  toBool,
  clampInt,
  readJson,
  writeJsonAtomic,
  nowIso
} = require('../../lib/queued_backlog_runtime');
const { runStandardLane } = require('../../lib/upgrade_lane_runtime');

const POLICY_PATH = process.env.RSI_SWARM_SPAWN_BRIDGE_POLICY_PATH
  ? path.resolve(process.env.RSI_SWARM_SPAWN_BRIDGE_POLICY_PATH)
  : path.join(ROOT, 'config', 'rsi_swarm_spawn_bridge_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/spawn/rsi_swarm_spawn_bridge.js configure --owner=<owner_id>');
  console.log('  node systems/spawn/rsi_swarm_spawn_bridge.js bridge --owner=<owner_id> --parent=<parent_id> --child=<child_id> [--apply=0|1] [--mock=0|1] [--strict=1]');
  console.log('  node systems/spawn/rsi_swarm_spawn_bridge.js status [--owner=<owner_id>]');
}

function parseJson(stdout) {
  const txt = String(stdout || '').trim();
  if (!txt) return null;
  try { return JSON.parse(txt); } catch {}
  const lines = txt.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function runNode(scriptPath, args, timeoutMs, mock, label) {
  if (mock) {
    return {
      ok: true,
      status: 0,
      payload: { ok: true, type: `${normalizeToken(label || 'mock', 80) || 'mock'}_mock` },
      stderr: ''
    };
  }
  const run = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: timeoutMs
  });
  return {
    ok: Number(run.status || 0) === 0,
    status: Number.isFinite(run.status) ? Number(run.status) : 1,
    payload: parseJson(run.stdout || ''),
    stderr: cleanText(run.stderr || '', 400)
  };
}

function rel(absPath) {
  return path.relative(ROOT, absPath).replace(/\\/g, '/');
}

function resolveMaybe(rawPath, fallbackRel) {
  const txt = cleanText(rawPath || '', 420);
  if (!txt) return path.join(ROOT, fallbackRel);
  return path.isAbsolute(txt) ? path.resolve(txt) : path.join(ROOT, txt);
}

function readState(policy) {
  return readJson(policy.paths.bridge_state_path, {
    schema_id: 'rsi_swarm_spawn_bridge_state',
    schema_version: '1.0',
    runs: 0,
    updated_at: null,
    last_bridge: null
  });
}

function writeState(policy, state) {
  const fs = require('fs');
  fs.mkdirSync(path.dirname(policy.paths.bridge_state_path), { recursive: true });
  writeJsonAtomic(policy.paths.bridge_state_path, {
    schema_id: 'rsi_swarm_spawn_bridge_state',
    schema_version: '1.0',
    runs: Number(state.runs || 0),
    updated_at: state.updated_at || nowIso(),
    last_bridge: state.last_bridge || null
  });
}

runStandardLane({
  lane_id: 'V3-RACE-182',
  script_rel: 'systems/spawn/rsi_swarm_spawn_bridge.js',
  policy_path: POLICY_PATH,
  stream: 'spawn.rsi_swarm_bridge',
  paths: {
    memory_dir: 'memory/spawn/rsi_swarm_spawn_bridge',
    adaptive_index_path: 'adaptive/spawn/rsi_swarm_spawn_bridge/index.json',
    events_path: 'state/spawn/rsi_swarm_spawn_bridge/events.jsonl',
    latest_path: 'state/spawn/rsi_swarm_spawn_bridge/latest.json',
    receipts_path: 'state/spawn/rsi_swarm_spawn_bridge/receipts.jsonl',
    bridge_state_path: 'state/spawn/rsi_swarm_spawn_bridge/state.json'
  },
  usage,
  handlers: {
    bridge(policy, args, ctx) {
      const ownerId = normalizeToken(args.owner || args.owner_id, 120);
      const parentId = normalizeToken(args.parent || args.parent_id, 120);
      const childId = normalizeToken(args.child || args.child_id, 120);
      if (!ownerId || !parentId || !childId) {
        return { ok: false, error: 'owner_parent_child_required' };
      }

      const strict = toBool(args.strict, true);
      const apply = toBool(args.apply, false);
      const mock = toBool(args.mock, false);
      const requestedCells = clampInt(args['requested-cells'] || args.requested_cells, 1, 32, clampInt(policy.requested_cells, 1, 32, 1));

      const lineageScript = resolveMaybe(policy.seed_lineage_script, 'systems/spawn/seed_spawn_lineage.js');
      const nurseryScript = resolveMaybe(policy.nursery_script, 'systems/nursery/nursery_bootstrap.js');
      const spawnBrokerScript = resolveMaybe(policy.spawn_broker_script, 'systems/spawn/spawn_broker.js');
      const provenanceScript = resolveMaybe(policy.provenance_gate_script, 'systems/security/supply_chain_provenance_gate.js');

      const provenanceRun = runNode(
        provenanceScript,
        ['check', `--owner=${ownerId}`, '--mode=strict'],
        120000,
        mock,
        'supply_chain_provenance_gate'
      );
      const lineageRun = runNode(
        lineageScript,
        [
          'preview',
          `--owner=${ownerId}`,
          `--parent=${parentId}`,
          `--child=${childId}`,
          '--profile=seed_spawn',
          `--apply=${apply ? '1' : '0'}`,
          '--directives=constitution,venom_gate',
          '--contracts=soul_anchor,agent_constitution'
        ],
        120000,
        mock,
        'seed_spawn_lineage_preview'
      );
      const nurseryRun = runNode(
        nurseryScript,
        ['run', '--strict', '--no-pull'],
        240000,
        mock,
        'nursery_bootstrap_run'
      );
      const spawnRun = runNode(
        spawnBrokerScript,
        [
          'request',
          '--module=rsi',
          `--owner=${ownerId}`,
          `--parent=${parentId}`,
          `--child=${childId}`,
          `--requested_cells=${String(requestedCells)}`,
          '--profile=seed_spawn',
          '--reason=rsi_swarm_spawn_bridge',
          `--apply=${apply ? '1' : '0'}`
        ],
        240000,
        mock,
        'spawn_broker_request'
      );

      const bridgeOk = provenanceRun.ok && lineageRun.ok && nurseryRun.ok && spawnRun.ok;

      if (apply) {
        const state = readState(policy);
        writeState(policy, {
          runs: Number(state.runs || 0) + 1,
          updated_at: nowIso(),
          last_bridge: {
            owner_id: ownerId,
            parent_id: parentId,
            child_id: childId,
            requested_cells: requestedCells,
            ok: bridgeOk,
            ts: nowIso()
          }
        });
      }

      const receipt = ctx.cmdRecord(policy, {
        ...args,
        event: 'rsi_swarm_spawn_bridge',
        apply,
        payload_json: JSON.stringify({
          owner_id: ownerId,
          parent_id: parentId,
          child_id: childId,
          requested_cells: requestedCells,
          strict,
          bridge_ok: bridgeOk,
          provenance_ok: provenanceRun.ok,
          lineage_ok: lineageRun.ok,
          nursery_ok: nurseryRun.ok,
          spawn_ok: spawnRun.ok,
          scripts: {
            provenance: rel(provenanceScript),
            lineage: rel(lineageScript),
            nursery: rel(nurseryScript),
            spawn_broker: rel(spawnBrokerScript)
          }
        })
      });

      if (strict && !bridgeOk) {
        return {
          ...receipt,
          ok: false,
          error: 'rsi_swarm_spawn_bridge_failed'
        };
      }

      return {
        ...receipt,
        rsi_swarm_spawn_bridge_ok: bridgeOk,
        lineage_ok: lineageRun.ok,
        provenance_ok: provenanceRun.ok,
        spawn_ok: spawnRun.ok
      };
    },

    status(policy, args, ctx) {
      const base = ctx.cmdStatus(policy, args);
      const state = readState(policy);
      return {
        ...base,
        bridge_state: state,
        artifacts: {
          ...base.artifacts,
          bridge_state_path: rel(policy.paths.bridge_state_path)
        }
      };
    }
  }
});
