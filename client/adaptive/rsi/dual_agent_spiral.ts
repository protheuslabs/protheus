#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-179
 * Dual-agent RSI spiral: System3 planner proposes increasing difficulty,
 * RSI executor performs bounded steps with deterministic receipts.
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
  clampInt,
  readJson,
  writeJsonAtomic
} = require('../../lib/queued_backlog_runtime');
const { runStandardLane } = require('../../lib/upgrade_lane_runtime');

const POLICY_PATH = process.env.RSI_DUAL_AGENT_SPIRAL_POLICY_PATH
  ? path.resolve(process.env.RSI_DUAL_AGENT_SPIRAL_POLICY_PATH)
  : path.join(ROOT, 'config', 'rsi_dual_agent_spiral_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node adaptive/rsi/dual_agent_spiral.js configure --owner=<owner_id>');
  console.log('  node adaptive/rsi/dual_agent_spiral.js run --owner=<owner_id> [--cycles=3] [--mock=1] [--apply=0] [--strict=1]');
  console.log('  node adaptive/rsi/dual_agent_spiral.js status [--owner=<owner_id>]');
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

function rel(absPath) {
  return path.relative(ROOT, absPath).replace(/\\/g, '/');
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function runNode(scriptPath, args, timeoutMs, mock, label) {
  if (mock) {
    return {
      ok: true,
      status: 0,
      payload: {
        ok: true,
        type: `${normalizeToken(label || 'mock', 80) || 'mock'}_mock`,
        script: rel(scriptPath),
        args
      },
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

function readState(policy) {
  return readJson(policy.paths.spiral_state_path, {
    schema_id: 'rsi_dual_agent_spiral_state',
    schema_version: '1.0',
    runs: 0,
    updated_at: null,
    last_cycle_count: 0,
    last_difficulty: 0,
    last_ok: null
  });
}

function writeState(policy, state) {
  ensureDir(policy.paths.spiral_state_path);
  writeJsonAtomic(policy.paths.spiral_state_path, {
    schema_id: 'rsi_dual_agent_spiral_state',
    schema_version: '1.0',
    runs: Number(state.runs || 0),
    updated_at: state.updated_at || nowIso(),
    last_cycle_count: Number(state.last_cycle_count || 0),
    last_difficulty: Number(state.last_difficulty || 0),
    last_ok: state.last_ok === true,
    last_result: state.last_result || null
  });
}

function targetPaths(policy) {
  const rows = Array.isArray(policy.target_paths) ? policy.target_paths : [];
  const out = rows.map((row) => cleanText(row, 280)).filter(Boolean);
  if (out.length > 0) return out;
  return [
    'systems/strategy/strategy_learner.ts',
    'systems/autonomy/model_catalog_loop.ts',
    'adaptive/executive/system3_executive_layer.ts'
  ];
}

runStandardLane({
  lane_id: 'V3-RACE-179',
  script_rel: 'adaptive/rsi/dual_agent_spiral.js',
  policy_path: POLICY_PATH,
  stream: 'adaptive.rsi.dual_agent_spiral',
  paths: {
    memory_dir: 'memory/adaptive/rsi_dual_agent_spiral',
    adaptive_index_path: 'adaptive/rsi/dual_agent_spiral/index.json',
    events_path: 'state/adaptive/rsi_dual_agent_spiral/events.jsonl',
    latest_path: 'state/adaptive/rsi_dual_agent_spiral/latest.json',
    receipts_path: 'state/adaptive/rsi_dual_agent_spiral/receipts.jsonl',
    spiral_state_path: 'state/adaptive/rsi_dual_agent_spiral/state.json'
  },
  usage,
  handlers: {
    run(policy, args, ctx) {
      const ownerId = normalizeToken(args.owner || args.owner_id, 120);
      if (!ownerId) return { ok: false, error: 'missing_owner' };

      const mock = toBool(args.mock, false);
      const strict = toBool(args.strict, true);
      const apply = toBool(args.apply, false);
      const requestedCycles = clampInt(args.cycles, 1, 12, clampInt(policy.cycles_default, 1, 12, 3));
      const startDifficulty = clampInt(args['difficulty-start'] || args.difficulty_start, 1, 32, clampInt(policy.difficulty_start, 1, 32, 1));
      const stepDifficulty = clampInt(args['difficulty-step'] || args.difficulty_step, 1, 8, clampInt(policy.difficulty_step, 1, 8, 1));
      const maxDifficulty = clampInt(args['difficulty-max'] || args.difficulty_max, 1, 64, clampInt(policy.difficulty_max, 1, 64, 6));
      const paths = targetPaths(policy);

      const system3Script = policy.system3_script
        ? (path.isAbsolute(String(policy.system3_script)) ? String(policy.system3_script) : path.join(ROOT, String(policy.system3_script)))
        : path.join(ROOT, 'adaptive', 'executive', 'system3_executive_layer.js');
      const rsiScript = policy.rsi_script
        ? (path.isAbsolute(String(policy.rsi_script)) ? String(policy.rsi_script) : path.join(ROOT, String(policy.rsi_script)))
        : path.join(ROOT, 'adaptive', 'rsi', 'rsi_bootstrap.js');
      const rsiPolicyPath = policy.rsi_policy_path
        ? (path.isAbsolute(String(policy.rsi_policy_path)) ? String(policy.rsi_policy_path) : path.join(ROOT, String(policy.rsi_policy_path)))
        : path.join(ROOT, 'config', 'rsi_bootstrap_policy.json');

      let difficulty = startDifficulty;
      const cycles = [];
      for (let i = 0; i < requestedCycles; i += 1) {
        const targetPath = paths[Math.min(i, paths.length - 1)] || paths[0];
        const objectiveId = `rsi_dual_agent_d${difficulty}`;

        const planner = runNode(
          system3Script,
          ['execute', `--owner=${ownerId}`, `--task=${objectiveId}`, '--risk-tier=2'],
          120000,
          mock,
          'system3_planner'
        );
        const executorArgs = [
          'step',
          `--owner=${ownerId}`,
          `--objective-id=${objectiveId}`,
          `--target-path=${targetPath}`,
          '--risk=medium',
          `--apply=${apply ? '1' : '0'}`,
          `--policy=${rsiPolicyPath}`
        ];
        if (mock) executorArgs.push('--mock=1');
        const executor = runNode(
          rsiScript,
          executorArgs,
          240000,
          false,
          'rsi_executor'
        );

        const executorPayload = executor.payload && typeof executor.payload === 'object' ? executor.payload : {};
        const cycleOk = planner.ok === true
          && executor.ok === true
          && normalizeToken(executorPayload.type, 80) === 'rsi_step'
          && executorPayload.ok !== false;

        cycles.push({
          index: i + 1,
          difficulty,
          objective_id: objectiveId,
          target_path: targetPath,
          planner_ok: planner.ok,
          planner_status: planner.status,
          executor_ok: executor.ok,
          executor_status: executor.status,
          cycle_ok: cycleOk
        });

        difficulty = cycleOk
          ? Math.min(maxDifficulty, difficulty + stepDifficulty)
          : difficulty;
      }

      const allOk = cycles.length > 0 && cycles.every((row) => row.cycle_ok === true);
      if (apply) {
        const state = readState(policy);
        writeState(policy, {
          runs: Number(state.runs || 0) + 1,
          updated_at: nowIso(),
          last_cycle_count: cycles.length,
          last_difficulty: cycles.length > 0 ? Number(cycles[cycles.length - 1].difficulty || 0) : 0,
          last_ok: allOk,
          last_result: {
            owner_id: ownerId,
            ts: nowIso(),
            requested_cycles: requestedCycles,
            cycles
          }
        });
      }

      const receipt = ctx.cmdRecord(policy, {
        ...args,
        event: 'rsi_dual_agent_spiral_run',
        apply,
        payload_json: JSON.stringify({
          owner_id: ownerId,
          requested_cycles: requestedCycles,
          start_difficulty: startDifficulty,
          step_difficulty: stepDifficulty,
          max_difficulty: maxDifficulty,
          all_ok: allOk,
          cycles,
          planner_script: rel(system3Script),
          rsi_script: rel(rsiScript),
          rsi_policy_path: rel(rsiPolicyPath),
          spiral_state_path: rel(policy.paths.spiral_state_path)
        })
      });

      if (strict && !allOk) {
        return {
          ...receipt,
          ok: false,
          error: 'dual_agent_spiral_failed',
          failed_cycles: cycles.filter((row) => row.cycle_ok !== true).map((row) => row.index),
          cycles
        };
      }

      return {
        ...receipt,
        dual_agent_spiral_ok: allOk,
        cycles
      };
    },

    status(policy, args, ctx) {
      const base = ctx.cmdStatus(policy, args);
      const state = readState(policy);
      return {
        ...base,
        spiral_state: state,
        artifacts: {
          ...base.artifacts,
          spiral_state_path: rel(policy.paths.spiral_state_path)
        }
      };
    }
  }
});
