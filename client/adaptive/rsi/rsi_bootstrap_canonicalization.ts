#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-178
 * Canonical policy surface for adaptive/rsi/rsi_bootstrap lifecycle commands.
 */

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

const POLICY_PATH = process.env.RSI_BOOTSTRAP_CANONICALIZATION_POLICY_PATH
  ? path.resolve(process.env.RSI_BOOTSTRAP_CANONICALIZATION_POLICY_PATH)
  : path.join(ROOT, 'config', 'rsi_bootstrap_canonicalization_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node adaptive/rsi/rsi_bootstrap_canonicalization.js configure --owner=<owner_id>');
  console.log('  node adaptive/rsi/rsi_bootstrap_canonicalization.js verify --owner=<owner_id> [--strict=1] [--mock=1] [--apply=1]');
  console.log('  node adaptive/rsi/rsi_bootstrap_canonicalization.js status [--owner=<owner_id>]');
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
  const fs = require('fs');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function readCommands(policy) {
  const rows = Array.isArray(policy.commands) ? policy.commands : [];
  const out = rows
    .map((row) => ({
      id: normalizeToken(row && row.id, 80),
      command: normalizeToken(row && row.command, 80),
      args: Array.isArray(row && row.args) ? row.args.map((arg) => cleanText(arg, 220)).filter(Boolean) : [],
      expect_type: normalizeToken(row && row.expect_type, 120),
      timeout_ms: clampInt(row && row.timeout_ms, 500, 30 * 60 * 1000, 120000)
    }))
    .filter((row) => row.id && row.command);
  if (out.length > 0) return out;
  return [
    { id: 'bootstrap', command: 'bootstrap', args: ['--mock=1'], expect_type: 'rsi_bootstrap', timeout_ms: 120000 },
    { id: 'contract_lane_status', command: 'contract-lane-status', args: ['--mock=1'], expect_type: 'rsi_contract_lane_status', timeout_ms: 120000 },
    { id: 'approve', command: 'approve', args: ['--approver=canon_reviewer', '--reason=canon_test', '--ttl-hours=1'], expect_type: 'rsi_approve', timeout_ms: 120000 },
    { id: 'step', command: 'step', args: ['--mock=1', '--apply=0', '--target-path=systems/ops/protheusctl.ts', '--objective-id=canon_objective'], expect_type: 'rsi_step', timeout_ms: 240000 },
    { id: 'status', command: 'status', args: [], expect_type: 'rsi_status', timeout_ms: 120000 },
    { id: 'hands_loop', command: 'hands-loop', args: ['--mock=1', '--iterations=1', '--interval-sec=0'], expect_type: 'rsi_hands_loop', timeout_ms: 240000 }
  ];
}

function runNode(scriptPath, args, timeoutMs) {
  const run = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: timeoutMs
  });
  const payload = parseJson(run.stdout || '');
  return {
    ok: Number(run.status || 0) === 0,
    status: Number.isFinite(run.status) ? Number(run.status) : 1,
    payload,
    stderr: cleanText(run.stderr || '', 400)
  };
}

function readState(policy) {
  return readJson(policy.paths.verification_state_path, {
    schema_id: 'rsi_bootstrap_canonicalization_state',
    schema_version: '1.0',
    runs: 0,
    updated_at: null,
    last_run: null
  });
}

function writeState(policy, state) {
  ensureDir(policy.paths.verification_state_path);
  writeJsonAtomic(policy.paths.verification_state_path, {
    schema_id: 'rsi_bootstrap_canonicalization_state',
    schema_version: '1.0',
    runs: Number(state.runs || 0),
    updated_at: state.updated_at || nowIso(),
    last_run: state.last_run || null
  });
}

runStandardLane({
  lane_id: 'V3-RACE-178',
  script_rel: 'adaptive/rsi/rsi_bootstrap_canonicalization.js',
  policy_path: POLICY_PATH,
  stream: 'adaptive.rsi.bootstrap_canonicalization',
  paths: {
    memory_dir: 'memory/adaptive/rsi_bootstrap_canonicalization',
    adaptive_index_path: 'adaptive/rsi/bootstrap_canonicalization/index.json',
    events_path: 'state/adaptive/rsi_bootstrap_canonicalization/events.jsonl',
    latest_path: 'state/adaptive/rsi_bootstrap_canonicalization/latest.json',
    receipts_path: 'state/adaptive/rsi_bootstrap_canonicalization/receipts.jsonl',
    verification_state_path: 'state/adaptive/rsi_bootstrap_canonicalization/state.json'
  },
  usage,
  handlers: {
    verify(policy, args, ctx) {
      const ownerId = normalizeToken(args.owner || args.owner_id, 120);
      if (!ownerId) return { ok: false, error: 'missing_owner' };

      const strict = toBool(args.strict, true);
      const apply = toBool(args.apply, true);
      const mock = toBool(args.mock, false);
      const rsiPolicyPath = policy.rsi_policy_path
        ? (path.isAbsolute(String(policy.rsi_policy_path)) ? String(policy.rsi_policy_path) : path.join(ROOT, String(policy.rsi_policy_path)))
        : path.join(ROOT, 'config', 'rsi_bootstrap_policy.json');
      const rsiScript = policy.rsi_script
        ? (path.isAbsolute(String(policy.rsi_script)) ? String(policy.rsi_script) : path.join(ROOT, String(policy.rsi_script)))
        : path.join(ROOT, 'adaptive', 'rsi', 'rsi_bootstrap.js');

      const commands = readCommands(policy);
      const checks = commands.map((row) => {
        const baseArgs = [row.command, `--owner=${ownerId}`, `--policy=${rsiPolicyPath}`, ...row.args];
        if (mock && !baseArgs.some((arg) => arg === '--mock=1' || arg === '--mock=true')) {
          baseArgs.push('--mock=1');
        }
        const run = runNode(rsiScript, baseArgs, row.timeout_ms);
        const payloadType = normalizeToken(run.payload && run.payload.type, 120) || null;
        const expectedType = row.expect_type || null;
        const typePass = expectedType ? payloadType === expectedType : true;
        return {
          id: row.id,
          command: row.command,
          ok: run.ok && typePass,
          status: run.status,
          expected_type: expectedType,
          payload_type: payloadType,
          stderr: run.stderr
        };
      });

      const allOk = checks.length > 0 && checks.every((row) => row.ok === true);
      if (apply) {
        const state = readState(policy);
        writeState(policy, {
          runs: Number(state.runs || 0) + 1,
          updated_at: nowIso(),
          last_run: {
            owner_id: ownerId,
            strict,
            mock,
            ok: allOk,
            checks
          }
        });
      }

      const receipt = ctx.cmdRecord(policy, {
        ...args,
        event: 'rsi_bootstrap_canonicalization_verify',
        apply,
        payload_json: JSON.stringify({
          owner_id: ownerId,
          strict,
          mock,
          command_count: checks.length,
          all_ok: allOk,
          checks,
          rsi_script: rel(rsiScript),
          rsi_policy_path: rel(rsiPolicyPath),
          state_path: rel(policy.paths.verification_state_path)
        })
      });

      if (strict && !allOk) {
        return {
          ...receipt,
          ok: false,
          error: 'rsi_bootstrap_contract_failed',
          failed_commands: checks.filter((row) => row.ok !== true).map((row) => row.id),
          checks
        };
      }

      return {
        ...receipt,
        rsi_bootstrap_contract_ok: allOk,
        checks
      };
    },

    status(policy, args, ctx) {
      const base = ctx.cmdStatus(policy, args);
      const state = readState(policy);
      return {
        ...base,
        verification_runs: Number(state.runs || 0),
        last_verification: state.last_run || null,
        artifacts: {
          ...base.artifacts,
          verification_state_path: rel(policy.paths.verification_state_path)
        }
      };
    }
  }
});
