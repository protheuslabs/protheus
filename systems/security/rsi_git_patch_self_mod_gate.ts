#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-180
 * Safe git-patch self-modification gate for RSI.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  ROOT,
  cleanText,
  normalizeToken,
  toBool,
  clampInt,
  clampNumber,
  readJson
} = require('../../lib/queued_backlog_runtime');
const { runStandardLane } = require('../../lib/upgrade_lane_runtime');

const POLICY_PATH = process.env.RSI_GIT_PATCH_SELF_MOD_GATE_POLICY_PATH
  ? path.resolve(process.env.RSI_GIT_PATCH_SELF_MOD_GATE_POLICY_PATH)
  : path.join(ROOT, 'config', 'rsi_git_patch_self_mod_gate_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/security/rsi_git_patch_self_mod_gate.js configure --owner=<owner_id>');
  console.log('  node systems/security/rsi_git_patch_self_mod_gate.js evaluate --owner=<owner_id> [--patch-file=<path>] [--approved=0|1] [--apply=0|1] [--mock=0|1] [--strict=1]');
  console.log('  node systems/security/rsi_git_patch_self_mod_gate.js status [--owner=<owner_id>]');
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
      stdout: '',
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
    stdout: String(run.stdout || ''),
    stderr: cleanText(run.stderr || '', 400)
  };
}

function runGit(args, timeoutMs) {
  const run = spawnSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: timeoutMs
  });
  return {
    ok: Number(run.status || 0) === 0,
    status: Number.isFinite(run.status) ? Number(run.status) : 1,
    stderr: cleanText(run.stderr || '', 400)
  };
}

function parseDopamineScore(run) {
  if (!run) return null;
  if (run.payload && typeof run.payload.score === 'number') return Number(run.payload.score);
  const payload = parseJson(run.stdout || '');
  if (payload && typeof payload.score === 'number') return Number(payload.score);
  return null;
}

function resolvePatch(rawPatch) {
  const txt = cleanText(rawPatch || '', 420);
  if (!txt) return null;
  return path.isAbsolute(txt) ? path.resolve(txt) : path.join(ROOT, txt);
}

function rel(absPath) {
  return path.relative(ROOT, absPath).replace(/\\/g, '/');
}

runStandardLane({
  lane_id: 'V3-RACE-180',
  script_rel: 'systems/security/rsi_git_patch_self_mod_gate.js',
  policy_path: POLICY_PATH,
  stream: 'security.rsi_git_patch_gate',
  paths: {
    memory_dir: 'memory/security/rsi_git_patch_self_mod_gate',
    adaptive_index_path: 'adaptive/security/rsi_git_patch_self_mod_gate/index.json',
    events_path: 'state/security/rsi_git_patch_self_mod_gate/events.jsonl',
    latest_path: 'state/security/rsi_git_patch_self_mod_gate/latest.json',
    receipts_path: 'state/security/rsi_git_patch_self_mod_gate/receipts.jsonl'
  },
  usage,
  handlers: {
    evaluate(policy, args, ctx) {
      const ownerId = normalizeToken(args.owner || args.owner_id, 120);
      if (!ownerId) return { ok: false, error: 'missing_owner' };

      const strict = toBool(args.strict, true);
      const apply = toBool(args.apply, false);
      const mock = toBool(args.mock, false);
      const approved = toBool(args.approved != null ? args.approved : args.approval, false);

      const scripts = policy.scripts && typeof policy.scripts === 'object' ? policy.scripts : {};
      const rsiScript = scripts.rsi_bootstrap
        ? (path.isAbsolute(String(scripts.rsi_bootstrap)) ? String(scripts.rsi_bootstrap) : path.join(ROOT, String(scripts.rsi_bootstrap)))
        : path.join(ROOT, 'adaptive', 'rsi', 'rsi_bootstrap.js');
      const rsiPolicyPath = scripts.rsi_policy
        ? (path.isAbsolute(String(scripts.rsi_policy)) ? String(scripts.rsi_policy) : path.join(ROOT, String(scripts.rsi_policy)))
        : path.join(ROOT, 'config', 'rsi_bootstrap_policy.json');
      const chaosScript = scripts.chaos
        ? (path.isAbsolute(String(scripts.chaos)) ? String(scripts.chaos) : path.join(ROOT, String(scripts.chaos)))
        : path.join(ROOT, 'systems', 'autonomy', 'red_team_harness.js');
      const constitutionScript = scripts.constitution
        ? (path.isAbsolute(String(scripts.constitution)) ? String(scripts.constitution) : path.join(ROOT, String(scripts.constitution)))
        : path.join(ROOT, 'systems', 'security', 'constitution_guardian.js');
      const habitScript = scripts.habit_lifecycle
        ? (path.isAbsolute(String(scripts.habit_lifecycle)) ? String(scripts.habit_lifecycle) : path.join(ROOT, String(scripts.habit_lifecycle)))
        : path.join(ROOT, 'habits', 'scripts', 'reflex_habit_bridge.js');
      const dopamineScript = scripts.dopamine
        ? (path.isAbsolute(String(scripts.dopamine)) ? String(scripts.dopamine) : path.join(ROOT, String(scripts.dopamine)))
        : path.join(ROOT, 'habits', 'scripts', 'dopamine_engine.js');

      const laneRun = runNode(
        rsiScript,
        ['contract-lane-status', `--owner=${ownerId}`, `--policy=${rsiPolicyPath}`, `--mock=${mock ? '1' : '0'}`],
        120000,
        false,
        'rsi_contract_lane_status'
      );
      const chaosRun = runNode(chaosScript, ['run', new Date().toISOString().slice(0, 10), '--strict=1'], 240000, mock, 'chaos_gate');
      const constitutionRun = runNode(constitutionScript, ['status'], 120000, mock, 'constitution_gate');
      const habitRun = runNode(habitScript, ['status'], 120000, mock, 'habit_gate');
      const dopamineRun = runNode(dopamineScript, ['score'], 120000, mock, 'dopamine_gate');

      const laneOk = laneRun.ok && laneRun.payload && laneRun.payload.ok === true;
      const chaosOk = chaosRun.ok === true;
      const constitutionOk = constitutionRun.ok === true;
      const habitOk = habitRun.ok === true;
      const dopamineScore = mock ? clampNumber(args['mock-score'], -9999, 9999, 5) : parseDopamineScore(dopamineRun);
      const minDopamine = clampNumber(policy.min_dopamine_score, -1000, 1000, 1);
      const dopamineOk = dopamineScore != null && Number(dopamineScore) >= minDopamine;

      const patchFileAbs = resolvePatch(args['patch-file'] || args.patch_file);
      const patchRequired = toBool(policy.patch_required, false);
      const patchExists = patchFileAbs ? fs.existsSync(patchFileAbs) : false;
      const patchCheck = patchExists ? runGit(['apply', '--check', patchFileAbs], 120000) : null;

      const denialReasons = [];
      if (!laneOk) denialReasons.push('contract_lane_failed');
      if (!chaosOk) denialReasons.push('chaos_gate_failed');
      if (!constitutionOk) denialReasons.push('constitution_gate_failed');
      if (!habitOk) denialReasons.push('habit_lifecycle_failed');
      if (!dopamineOk) denialReasons.push('dopamine_gate_failed');
      if (toBool(policy.require_human_approval, true) && !approved) denialReasons.push('approval_required');
      if (patchRequired && !patchExists) denialReasons.push('patch_file_missing');
      if (patchExists && patchCheck && !patchCheck.ok) denialReasons.push('patch_check_failed');

      const gateOk = denialReasons.length === 0;
      let patchApply = null;
      if (patchExists) {
        if (apply && gateOk) {
          const applyRun = runGit(['apply', patchFileAbs], 120000);
          patchApply = {
            attempted: true,
            ok: applyRun.ok,
            status: applyRun.status,
            stderr: applyRun.stderr
          };
          if (!applyRun.ok) denialReasons.push('patch_apply_failed');
        } else {
          patchApply = {
            attempted: false,
            reason: apply ? 'gate_not_passed' : 'apply_not_requested'
          };
        }
      }

      const finalOk = denialReasons.length === 0;
      const receipt = ctx.cmdRecord(policy, {
        ...args,
        event: 'rsi_git_patch_self_mod_gate_evaluate',
        apply,
        payload_json: JSON.stringify({
          owner_id: ownerId,
          strict,
          approved,
          min_dopamine_score: minDopamine,
          dopamine_score: dopamineScore,
          gate_ok: finalOk,
          denial_reasons: denialReasons,
          checks: {
            contract_lanes_ok: laneOk,
            chaos_ok: chaosOk,
            constitution_ok: constitutionOk,
            habit_ok: habitOk,
            dopamine_ok: dopamineOk
          },
          patch_file: patchFileAbs ? rel(patchFileAbs) : null,
          patch_exists: patchExists,
          patch_check: patchCheck,
          patch_apply: patchApply
        })
      });

      if (strict && !finalOk) {
        return {
          ...receipt,
          ok: false,
          error: 'self_mod_gate_denied',
          denial_reasons: denialReasons,
          patch_apply: patchApply
        };
      }

      return {
        ...receipt,
        self_mod_gate_ok: finalOk,
        denial_reasons: denialReasons,
        patch_apply: patchApply
      };
    }
  }
});
