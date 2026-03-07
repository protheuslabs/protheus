#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-177
 * System3 meta-curriculum handoff into strategy learner + model catalog loop.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  ROOT,
  nowIso,
  cleanText,
  normalizeToken,
  stableHash,
  toBool,
  readJson,
  writeJsonAtomic
} = require('../../lib/queued_backlog_runtime');
const { runStandardLane } = require('../../lib/upgrade_lane_runtime');

const POLICY_PATH = process.env.SYSTEM3_META_CURRICULUM_BRIDGE_POLICY_PATH
  ? path.resolve(process.env.SYSTEM3_META_CURRICULUM_BRIDGE_POLICY_PATH)
  : path.join(ROOT, 'config', 'system3_meta_curriculum_bridge_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node adaptive/executive/system3_meta_curriculum_bridge.js configure --owner=<owner_id>');
  console.log('  node adaptive/executive/system3_meta_curriculum_bridge.js run --owner=<owner_id> [--task=meta_curriculum] [--days=7] [--mock=0|1] [--apply=1]');
  console.log('  node adaptive/executive/system3_meta_curriculum_bridge.js status [--owner=<owner_id>]');
}

function parseJson(stdout: string) {
  const txt = String(stdout || '').trim();
  if (!txt) return null;
  try { return JSON.parse(txt); } catch {}
  const lines = txt.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function runNode(scriptPath: string, args: string[], mock = false, timeoutMs = 120000) {
  if (mock) {
    return {
      ok: true,
      status: 0,
      payload: {
        ok: true,
        type: 'mock',
        script: scriptPath,
        args
      },
      stderr: ''
    };
  }
  const proc = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: timeoutMs
  });
  return {
    ok: Number(proc.status || 0) === 0,
    status: Number.isFinite(proc.status) ? Number(proc.status) : 1,
    payload: parseJson(proc.stdout || ''),
    stderr: cleanText(proc.stderr || '', 400)
  };
}

function rel(absPath: string) {
  return path.relative(ROOT, absPath).replace(/\\/g, '/');
}

function ensureDir(filePath: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function readBridgeState(policy: any) {
  return readJson(policy.paths.curriculum_state_path, {
    schema_id: 'system3_meta_curriculum_bridge_state',
    schema_version: '1.0',
    runs: 0,
    last_handoff_id: null,
    updated_at: null
  });
}

function writeBridgeState(policy: any, state: any) {
  ensureDir(policy.paths.curriculum_state_path);
  writeJsonAtomic(policy.paths.curriculum_state_path, state);
}

runStandardLane({
  lane_id: 'V3-RACE-177',
  script_rel: 'adaptive/executive/system3_meta_curriculum_bridge.js',
  policy_path: POLICY_PATH,
  stream: 'executive.system3_curriculum',
  paths: {
    memory_dir: 'memory/executive/system3_meta_curriculum_bridge',
    adaptive_index_path: 'adaptive/executive/system3_meta_curriculum_bridge/index.json',
    events_path: 'state/executive/system3_meta_curriculum_bridge/events.jsonl',
    latest_path: 'state/executive/system3_meta_curriculum_bridge/latest.json',
    receipts_path: 'state/executive/system3_meta_curriculum_bridge/receipts.jsonl',
    curriculum_state_path: 'state/executive/system3_meta_curriculum_bridge/state.json',
    curriculum_artifact_path: 'state/executive/system3_meta_curriculum_bridge/curriculum_latest.json'
  },
  usage,
  handlers: {
    run(policy: any, args: any, ctx: any) {
      const ownerId = normalizeToken(args.owner || args.owner_id, 120);
      if (!ownerId) return { ok: false, error: 'missing_owner' };

      const apply = toBool(args.apply, true);
      const mock = toBool(args.mock, false);
      const task = normalizeToken(args.task || 'meta_curriculum', 120) || 'meta_curriculum';
      const days = Number.isFinite(Number(args.days)) ? Math.max(1, Math.min(60, Number(args.days))) : 7;

      const system3Script = policy.scripts && policy.scripts.system3
        ? path.isAbsolute(String(policy.scripts.system3)) ? String(policy.scripts.system3) : path.join(ROOT, String(policy.scripts.system3))
        : path.join(ROOT, 'adaptive', 'executive', 'system3_executive_layer.js');
      const strategyScript = policy.scripts && policy.scripts.strategy_learner
        ? path.isAbsolute(String(policy.scripts.strategy_learner)) ? String(policy.scripts.strategy_learner) : path.join(ROOT, String(policy.scripts.strategy_learner))
        : path.join(ROOT, 'systems', 'strategy', 'strategy_learner.js');
      const modelScript = policy.scripts && policy.scripts.model_catalog
        ? path.isAbsolute(String(policy.scripts.model_catalog)) ? String(policy.scripts.model_catalog) : path.join(ROOT, String(policy.scripts.model_catalog))
        : path.join(ROOT, 'systems', 'autonomy', 'model_catalog_loop.js');

      const system3Run = runNode(system3Script, ['execute', `--owner=${ownerId}`, `--task=${task}`, '--risk-tier=2'], mock);
      const strategyRun = runNode(strategyScript, ['run', nowIso().slice(0, 10), `--days=${String(days)}`, '--persist=1'], mock, 240000);
      const modelRun = runNode(modelScript, ['report'], mock, 240000);

      const handoffId = `curr_${stableHash(`${ownerId}|${task}|${nowIso()}`, 18)}`;
      const lineageHash = stableHash(JSON.stringify({
        handoff_id: handoffId,
        owner_id: ownerId,
        task,
        system3_ok: system3Run.ok,
        strategy_ok: strategyRun.ok,
        model_ok: modelRun.ok,
        ts: nowIso()
      }), 32);

      const artifact = {
        schema_id: 'system3_meta_curriculum_handoff',
        schema_version: '1.0',
        handoff_id: handoffId,
        owner_id: ownerId,
        task,
        days,
        ts: nowIso(),
        lineage_hash: lineageHash,
        runs: {
          system3: { ok: system3Run.ok, status: system3Run.status, payload: system3Run.payload },
          strategy_learner: { ok: strategyRun.ok, status: strategyRun.status, payload: strategyRun.payload },
          model_catalog: { ok: modelRun.ok, status: modelRun.status, payload: modelRun.payload }
        }
      };

      if (apply) {
        ensureDir(policy.paths.curriculum_artifact_path);
        writeJsonAtomic(policy.paths.curriculum_artifact_path, artifact);
        const state = readBridgeState(policy);
        writeBridgeState(policy, {
          ...state,
          runs: Number(state.runs || 0) + 1,
          last_handoff_id: handoffId,
          updated_at: nowIso()
        });
      }

      return ctx.cmdRecord(policy, {
        ...args,
        event: 'system3_meta_curriculum_handoff',
        apply,
        payload_json: JSON.stringify({
          owner_id: ownerId,
          handoff_id: handoffId,
          lineage_hash: lineageHash,
          task,
          days,
          all_ok: system3Run.ok && strategyRun.ok && modelRun.ok,
          artifact_path: rel(policy.paths.curriculum_artifact_path)
        })
      });
    },

    status(policy: any, args: any, ctx: any) {
      const base = ctx.cmdStatus(policy, args);
      const state = readBridgeState(policy);
      const artifact = readJson(policy.paths.curriculum_artifact_path, null);
      return {
        ...base,
        state,
        latest_handoff: artifact,
        artifacts: {
          ...base.artifacts,
          curriculum_state_path: rel(policy.paths.curriculum_state_path),
          curriculum_artifact_path: rel(policy.paths.curriculum_artifact_path)
        }
      };
    }
  }
});
