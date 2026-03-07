#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-184
 * Control-plane CLI surface contract for RSI and contract-lane visibility.
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
  readJson,
  readJsonl,
  writeJsonAtomic
} = require('../../lib/queued_backlog_runtime');
const { runStandardLane } = require('../../lib/upgrade_lane_runtime');

const POLICY_PATH = process.env.RSI_CONTROL_PLANE_CLI_SURFACE_CONTRACT_POLICY_PATH
  ? path.resolve(process.env.RSI_CONTROL_PLANE_CLI_SURFACE_CONTRACT_POLICY_PATH)
  : path.join(ROOT, 'config', 'rsi_control_plane_cli_surface_contract_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/rsi_control_plane_cli_surface_contract.js configure --owner=<owner_id>');
  console.log('  node systems/ops/rsi_control_plane_cli_surface_contract.js verify --owner=<owner_id> [--strict=1] [--apply=1]');
  console.log('  node systems/ops/rsi_control_plane_cli_surface_contract.js status [--owner=<owner_id>]');
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

function runCtl(scriptPath, args, timeoutMs) {
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
  return readJson(policy.paths.contract_state_path, {
    schema_id: 'rsi_control_plane_cli_surface_contract_state',
    schema_version: '1.0',
    runs: 0,
    updated_at: null,
    last_result: null
  });
}

function writeState(policy, state) {
  fs.mkdirSync(path.dirname(policy.paths.contract_state_path), { recursive: true });
  writeJsonAtomic(policy.paths.contract_state_path, {
    schema_id: 'rsi_control_plane_cli_surface_contract_state',
    schema_version: '1.0',
    runs: Number(state.runs || 0),
    updated_at: state.updated_at || nowIso(),
    last_result: state.last_result || null
  });
}

runStandardLane({
  lane_id: 'V3-RACE-184',
  script_rel: 'systems/ops/rsi_control_plane_cli_surface_contract.js',
  policy_path: POLICY_PATH,
  stream: 'ops.rsi_control_plane_cli_surface',
  paths: {
    memory_dir: 'memory/ops/rsi_control_plane_cli_surface_contract',
    adaptive_index_path: 'adaptive/ops/rsi_control_plane_cli_surface_contract/index.json',
    events_path: 'state/ops/rsi_control_plane_cli_surface_contract/events.jsonl',
    latest_path: 'state/ops/rsi_control_plane_cli_surface_contract/latest.json',
    receipts_path: 'state/ops/rsi_control_plane_cli_surface_contract/receipts.jsonl',
    contract_state_path: 'state/ops/rsi_control_plane_cli_surface_contract/state.json'
  },
  usage,
  handlers: {
    verify(policy, args, ctx) {
      const ownerId = normalizeToken(args.owner || args.owner_id, 120);
      if (!ownerId) return { ok: false, error: 'missing_owner' };

      const strict = toBool(args.strict, true);
      const apply = toBool(args.apply, true);
      const ctlScript = resolveMaybe(policy.protheusctl_script, 'systems/ops/protheusctl.js');
      const rsiPolicyPath = resolveMaybe(policy.rsi_policy_path, 'config/rsi_bootstrap_policy.json');
      const historyPath = resolveMaybe(policy.rsi_history_path, 'state/adaptive/rsi/receipts.jsonl');

      const checks = [];
      const pushCheck = (id, argsList, expectedType) => {
        const run = runCtl(ctlScript, argsList, 240000);
        const payloadType = normalizeToken(run.payload && run.payload.type, 120) || null;
        const ok = run.ok && payloadType === normalizeToken(expectedType, 120);
        checks.push({ id, ok, status: run.status, expected_type: expectedType, payload_type: payloadType, stderr: run.stderr });
      };

      pushCheck(
        'rsi_bootstrap',
        ['rsi', 'bootstrap', `--owner=${ownerId}`, '--mock=1', `--policy=${rsiPolicyPath}`],
        'rsi_bootstrap'
      );
      pushCheck(
        'rsi_status',
        ['rsi', 'status', `--owner=${ownerId}`, `--policy=${rsiPolicyPath}`],
        'rsi_status'
      );
      pushCheck(
        'contract_lane_status',
        ['contract-lane', 'status', `--owner=${ownerId}`, '--mock=1', `--policy=${rsiPolicyPath}`],
        'rsi_contract_lane_status'
      );

      const historyRows = readJsonl(historyPath, []);
      const historyOk = Array.isArray(historyRows) && historyRows.length > 0;
      const allOk = checks.every((row) => row.ok === true) && historyOk;

      if (apply) {
        const state = readState(policy);
        writeState(policy, {
          runs: Number(state.runs || 0) + 1,
          updated_at: nowIso(),
          last_result: {
            owner_id: ownerId,
            ts: nowIso(),
            ok: allOk,
            checks,
            history_count: historyRows.length
          }
        });
      }

      const receipt = ctx.cmdRecord(policy, {
        ...args,
        event: 'rsi_control_plane_cli_surface_verify',
        apply,
        payload_json: JSON.stringify({
          owner_id: ownerId,
          strict,
          all_ok: allOk,
          checks,
          history_path: rel(historyPath),
          history_count: historyRows.length,
          protheusctl_script: rel(ctlScript),
          rsi_policy_path: rel(rsiPolicyPath)
        })
      });

      if (strict && !allOk) {
        return {
          ...receipt,
          ok: false,
          error: 'rsi_cli_surface_contract_failed',
          history_ok: historyOk,
          checks
        };
      }

      return {
        ...receipt,
        rsi_cli_surface_ok: allOk,
        history_ok: historyOk,
        checks
      };
    },

    status(policy, args, ctx) {
      const base = ctx.cmdStatus(policy, args);
      const state = readState(policy);
      return {
        ...base,
        contract_state: state,
        artifacts: {
          ...base.artifacts,
          contract_state_path: rel(policy.paths.contract_state_path)
        }
      };
    }
  }
});
