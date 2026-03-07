#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-187
 * Formal verification depth pack for critical runtime paths.
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

const POLICY_PATH = process.env.CRITICAL_RUNTIME_FORMAL_DEPTH_PACK_POLICY_PATH
  ? path.resolve(process.env.CRITICAL_RUNTIME_FORMAL_DEPTH_PACK_POLICY_PATH)
  : path.join(ROOT, 'config', 'critical_runtime_formal_depth_pack_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/security/critical_runtime_formal_depth_pack.js configure --owner=<owner_id>');
  console.log('  node systems/security/critical_runtime_formal_depth_pack.js verify --owner=<owner_id> [--mock=1] [--strict=1] [--apply=1]');
  console.log('  node systems/security/critical_runtime_formal_depth_pack.js status [--owner=<owner_id>]');
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
  return readJson(policy.paths.depth_pack_state_path, {
    schema_id: 'critical_runtime_formal_depth_pack_state',
    schema_version: '1.0',
    runs: 0,
    updated_at: null,
    last_result: null
  });
}

function writeState(policy, state) {
  fs.mkdirSync(path.dirname(policy.paths.depth_pack_state_path), { recursive: true });
  writeJsonAtomic(policy.paths.depth_pack_state_path, {
    schema_id: 'critical_runtime_formal_depth_pack_state',
    schema_version: '1.0',
    runs: Number(state.runs || 0),
    updated_at: state.updated_at || nowIso(),
    last_result: state.last_result || null
  });
}

runStandardLane({
  lane_id: 'V3-RACE-187',
  script_rel: 'systems/security/critical_runtime_formal_depth_pack.js',
  policy_path: POLICY_PATH,
  stream: 'security.critical_runtime_formal_depth_pack',
  paths: {
    memory_dir: 'memory/security/critical_runtime_formal_depth_pack',
    adaptive_index_path: 'adaptive/security/critical_runtime_formal_depth_pack/index.json',
    events_path: 'state/security/critical_runtime_formal_depth_pack/events.jsonl',
    latest_path: 'state/security/critical_runtime_formal_depth_pack/latest.json',
    receipts_path: 'state/security/critical_runtime_formal_depth_pack/receipts.jsonl',
    depth_pack_state_path: 'state/security/critical_runtime_formal_depth_pack/state.json'
  },
  usage,
  handlers: {
    verify(policy, args, ctx) {
      const ownerId = normalizeToken(args.owner || args.owner_id, 120);
      if (!ownerId) return { ok: false, error: 'missing_owner' };

      const strict = toBool(args.strict, true);
      const apply = toBool(args.apply, true);
      const mock = toBool(args.mock, false);

      const scripts = {
        critical_path_formal: resolveMaybe(policy.critical_path_formal_script, 'systems/security/critical_path_formal_verifier.js'),
        sovereignty_formal: resolveMaybe(policy.sovereignty_formal_script, 'systems/security/formal_mind_sovereignty_verification.js'),
        self_mod_gate: resolveMaybe(policy.self_mod_gate_script, 'systems/security/rsi_git_patch_self_mod_gate.js'),
        integrity_chain: resolveMaybe(policy.integrity_chain_script, 'adaptive/rsi/rsi_integrity_chain_guard.js'),
        provenance_gate: resolveMaybe(policy.provenance_gate_script, 'systems/security/supply_chain_provenance_gate.js')
      };

      const runs = {
        critical_path_formal: runNode(scripts.critical_path_formal, ['run', '--strict=1'], 240000, mock, 'critical_path_formal'),
        sovereignty_formal: runNode(scripts.sovereignty_formal, ['verify'], 120000, mock, 'sovereignty_formal'),
        self_mod_gate: runNode(scripts.self_mod_gate, ['evaluate', `--owner=${ownerId}`, '--approved=1', '--mock=1', '--strict=1'], 120000, mock, 'self_mod_gate'),
        integrity_chain: runNode(scripts.integrity_chain, ['verify', `--owner=${ownerId}`, '--mock=1', '--strict=1'], 120000, mock, 'integrity_chain'),
        provenance_gate: runNode(scripts.provenance_gate, ['check', `--owner=${ownerId}`, '--mode=strict'], 120000, mock, 'provenance_gate')
      };

      const checks = Object.entries(runs).map(([id, run]) => ({ id, ok: run.ok, status: run.status }));
      const allOk = checks.every((row) => row.ok === true);

      if (apply) {
        const state = readState(policy);
        writeState(policy, {
          runs: Number(state.runs || 0) + 1,
          updated_at: nowIso(),
          last_result: {
            owner_id: ownerId,
            ts: nowIso(),
            ok: allOk,
            checks
          }
        });
      }

      const receipt = ctx.cmdRecord(policy, {
        ...args,
        event: 'critical_runtime_formal_depth_pack_verify',
        apply,
        payload_json: JSON.stringify({
          owner_id: ownerId,
          strict,
          all_ok: allOk,
          checks,
          scripts: {
            critical_path_formal: rel(scripts.critical_path_formal),
            sovereignty_formal: rel(scripts.sovereignty_formal),
            self_mod_gate: rel(scripts.self_mod_gate),
            integrity_chain: rel(scripts.integrity_chain),
            provenance_gate: rel(scripts.provenance_gate)
          }
        })
      });

      if (strict && !allOk) {
        return {
          ...receipt,
          ok: false,
          error: 'critical_runtime_formal_depth_pack_failed',
          checks
        };
      }

      return {
        ...receipt,
        critical_runtime_formal_depth_pack_ok: allOk,
        checks
      };
    },

    status(policy, args, ctx) {
      const base = ctx.cmdStatus(policy, args);
      const state = readState(policy);
      return {
        ...base,
        depth_pack_state: state,
        artifacts: {
          ...base.artifacts,
          depth_pack_state_path: rel(policy.paths.depth_pack_state_path)
        }
      };
    }
  }
});
