#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-188
 * Hybrid interface stability contract (Rust core + TS orchestration).
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
  writeJsonAtomic
} = require('../../lib/queued_backlog_runtime');
const { runStandardLane } = require('../../lib/upgrade_lane_runtime');

const POLICY_PATH = process.env.HYBRID_INTERFACE_STABILITY_CONTRACT_POLICY_PATH
  ? path.resolve(process.env.HYBRID_INTERFACE_STABILITY_CONTRACT_POLICY_PATH)
  : path.join(ROOT, 'config', 'hybrid_interface_stability_contract_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/hybrid_interface_stability_contract.js configure --owner=<owner_id>');
  console.log('  node systems/ops/hybrid_interface_stability_contract.js verify --owner=<owner_id> [--mock=1] [--strict=1] [--apply=1]');
  console.log('  node systems/ops/hybrid_interface_stability_contract.js status [--owner=<owner_id>]');
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

function resolveMaybe(rawPath, fallbackRel) {
  const txt = cleanText(rawPath || '', 420);
  if (!txt) return path.join(ROOT, fallbackRel);
  return path.isAbsolute(txt) ? path.resolve(txt) : path.join(ROOT, txt);
}

function rel(absPath) {
  return path.relative(ROOT, absPath).replace(/\\/g, '/');
}

function readState(policy) {
  return readJson(policy.paths.hybrid_state_path, {
    schema_id: 'hybrid_interface_stability_contract_state',
    schema_version: '1.0',
    runs: 0,
    updated_at: null,
    last_result: null
  });
}

function writeState(policy, state) {
  fs.mkdirSync(path.dirname(policy.paths.hybrid_state_path), { recursive: true });
  writeJsonAtomic(policy.paths.hybrid_state_path, {
    schema_id: 'hybrid_interface_stability_contract_state',
    schema_version: '1.0',
    runs: Number(state.runs || 0),
    updated_at: state.updated_at || nowIso(),
    last_result: state.last_result || null
  });
}

function snapshotForRuns(runs) {
  const out = {};
  for (const [id, run] of Object.entries(runs || {})) {
    out[id] = {
      payload_type: normalizeToken(run && run.payload && run.payload.type, 120) || null,
      ok: run && run.ok === true
    };
  }
  return out;
}

runStandardLane({
  lane_id: 'V3-RACE-188',
  script_rel: 'systems/ops/hybrid_interface_stability_contract.js',
  policy_path: POLICY_PATH,
  stream: 'ops.hybrid_interface_stability_contract',
  paths: {
    memory_dir: 'memory/ops/hybrid_interface_stability_contract',
    adaptive_index_path: 'adaptive/ops/hybrid_interface_stability_contract/index.json',
    events_path: 'state/ops/hybrid_interface_stability_contract/events.jsonl',
    latest_path: 'state/ops/hybrid_interface_stability_contract/latest.json',
    receipts_path: 'state/ops/hybrid_interface_stability_contract/receipts.jsonl',
    hybrid_state_path: 'state/ops/hybrid_interface_stability_contract/state.json'
  },
  usage,
  handlers: {
    verify(policy, args, ctx) {
      const ownerId = normalizeToken(args.owner || args.owner_id, 120);
      if (!ownerId) return { ok: false, error: 'missing_owner' };

      const strict = toBool(args.strict, true);
      const apply = toBool(args.apply, true);
      const mock = toBool(args.mock, false);

      const protheusctlScript = resolveMaybe(policy.protheusctl_script, 'systems/ops/protheusctl.js');
      const rsiPolicy = resolveMaybe(policy.rsi_policy_path, 'config/rsi_bootstrap_policy.json');
      const rustCutoverScript = resolveMaybe(policy.rust_cutover_script, 'systems/ops/rust_control_plane_cutover.js');
      const profileCompatScript = resolveMaybe(policy.profile_compat_script, 'systems/ops/profile_compatibility_gate.js');
      const snapshotPath = resolveMaybe(policy.snapshot_path, 'state/ops/hybrid_interface_stability_contract/snapshot.json');

      const runs = {
        ctl_status: runNode(protheusctlScript, ['status'], 120000, mock, 'protheusctl_status'),
        ctl_rsi_status: runNode(protheusctlScript, ['rsi', 'status', `--owner=${ownerId}`, '--mock=1', `--policy=${rsiPolicy}`], 120000, mock, 'protheusctl_rsi_status'),
        ctl_contract_lane: runNode(protheusctlScript, ['contract-lane', 'status', `--owner=${ownerId}`, '--mock=1', `--policy=${rsiPolicy}`], 120000, mock, 'protheusctl_contract_lane'),
        profile_compat: runNode(profileCompatScript, ['run', '--strict=1', '--apply=0'], 120000, mock, 'profile_compatibility_gate'),
        rust_route_guard: runNode(rustCutoverScript, ['route', '--component=guard'], 120000, mock, 'rust_cutover_route_guard')
      };

      const currentSnapshot = snapshotForRuns(runs);
      const expectedSnapshot = readJson(snapshotPath, null);
      const snapshotMatch = expectedSnapshot == null
        ? true
        : JSON.stringify(expectedSnapshot) === JSON.stringify(currentSnapshot);

      let rollbackTriggered = false;
      if (!snapshotMatch && toBool(policy.auto_rollback_on_drift, true) && !mock) {
        const rollback = runNode(rustCutoverScript, ['activate', '--profile=emergency', '--apply=1'], 120000, false, 'rust_cutover_emergency');
        rollbackTriggered = rollback.ok;
      }

      if (apply) {
        fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
        if (expectedSnapshot == null || toBool(policy.refresh_snapshot_on_apply, true)) {
          writeJsonAtomic(snapshotPath, currentSnapshot);
        }
        const state = readState(policy);
        writeState(policy, {
          runs: Number(state.runs || 0) + 1,
          updated_at: nowIso(),
          last_result: {
            owner_id: ownerId,
            ts: nowIso(),
            snapshot_match: snapshotMatch,
            rollback_triggered: rollbackTriggered
          }
        });
      }

      const checks = Object.entries(runs).map(([id, run]) => ({ id, ok: run.ok, status: run.status }));
      const commandsOk = checks.every((row) => row.ok === true);
      const allOk = commandsOk && snapshotMatch;

      const receipt = ctx.cmdRecord(policy, {
        ...args,
        event: 'hybrid_interface_stability_contract_verify',
        apply,
        payload_json: JSON.stringify({
          owner_id: ownerId,
          strict,
          all_ok: allOk,
          checks,
          snapshot_match: snapshotMatch,
          rollback_triggered: rollbackTriggered,
          snapshot_path: rel(snapshotPath)
        })
      });

      if (strict && !allOk) {
        return {
          ...receipt,
          ok: false,
          error: 'hybrid_interface_stability_contract_failed',
          snapshot_match: snapshotMatch,
          rollback_triggered: rollbackTriggered
        };
      }

      return {
        ...receipt,
        hybrid_interface_stability_ok: allOk,
        snapshot_match: snapshotMatch,
        rollback_triggered: rollbackTriggered
      };
    },

    status(policy, args, ctx) {
      const base = ctx.cmdStatus(policy, args);
      const state = readState(policy);
      return {
        ...base,
        hybrid_state: state,
        artifacts: {
          ...base.artifacts,
          hybrid_state_path: rel(policy.paths.hybrid_state_path)
        }
      };
    }
  }
});
