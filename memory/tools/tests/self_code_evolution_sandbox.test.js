#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function runNode(scriptPath, args, env, cwd) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd,
    env,
    encoding: 'utf8'
  });
}

function parseJson(proc, label) {
  const raw = String(proc.stdout || '').trim();
  assert.ok(raw, `${label}: expected stdout`);
  return JSON.parse(raw.split('\n').filter(Boolean).slice(-1)[0]);
}

function run() {
  const root = path.resolve(__dirname, '..', '..', '..');
  const scriptPath = path.join(root, 'systems', 'autonomy', 'self_code_evolution_sandbox.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'self-code-evo-'));
  const policyPath = path.join(tmp, 'config', 'self_code_evolution_sandbox_policy.json');
  const statePath = path.join(tmp, 'state', 'autonomy', 'self_code_evolution_sandbox', 'state.json');
  const receiptsPath = path.join(tmp, 'state', 'autonomy', 'self_code_evolution_sandbox', 'receipts.jsonl');
  const symPolicyPath = path.join(tmp, 'config', 'symbiosis_coherence_policy.json');
  const identityLatestPath = path.join(tmp, 'sym', 'identity', 'latest.json');
  const preNeuralStatePath = path.join(tmp, 'sym', 'pre_neuralink', 'state.json');
  const deepSymStatePath = path.join(tmp, 'sym', 'deep', 'state.json');
  const observerLatestPath = path.join(tmp, 'sym', 'observer', 'latest.json');

  writeJson(identityLatestPath, {
    checked: 12,
    blocked: 0,
    identity_drift_score: 0.04,
    max_identity_drift_score: 0.58
  });
  writeJson(preNeuralStatePath, {
    consent_state: 'granted',
    signals_total: 10,
    routed_total: 9,
    blocked_total: 1
  });
  writeJson(deepSymStatePath, {
    samples: 80,
    style: {
      directness: 0.95,
      brevity: 0.9,
      proactive_delta: 0.9
    }
  });
  writeJson(observerLatestPath, {
    observer: { mood: 'stable' },
    summary: {
      rates: {
        ship_rate: 0.9,
        hold_rate: 0.05
      }
    }
  });

  writeJson(symPolicyPath, {
    version: '1.0-test',
    enabled: true,
    shadow_only: false,
    stale_after_minutes: 120,
    thresholds: {
      low_max: 0.45,
      medium_max: 0.75,
      high_min: 0.75,
      unbounded_min: 0.9,
      sustained_high_samples: 4
    },
    recursion: {
      low_depth: 1,
      medium_depth: 2,
      high_base_depth: 4,
      high_streak_gain_interval: 2,
      require_granted_consent_for_unbounded: true,
      require_identity_clear_for_unbounded: true
    },
    paths: {
      state_path: path.join(tmp, 'sym', 'coherence', 'state.json'),
      latest_path: path.join(tmp, 'sym', 'coherence', 'latest.json'),
      receipts_path: path.join(tmp, 'sym', 'coherence', 'receipts.jsonl'),
      identity_latest_path: identityLatestPath,
      pre_neuralink_state_path: preNeuralStatePath,
      deep_symbiosis_state_path: deepSymStatePath,
      observer_mirror_latest_path: observerLatestPath
    }
  });

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    shadow_only: false,
    max_active_sandboxes: 8,
    required_approvals: 2,
    require_tests_before_merge: true,
    sandbox_branch_prefix: 'codex/evo/',
    symbiosis_recursion_gate: {
      enabled: true,
      shadow_only: false,
      signal_policy_path: symPolicyPath
    },
    test_commands: [
      'node -e "process.exit(0)"'
    ]
  });

  const env = {
    ...process.env,
    SELF_CODE_EVOLUTION_POLICY_PATH: policyPath,
    SELF_CODE_EVOLUTION_STATE_PATH: statePath,
    SELF_CODE_EVOLUTION_RECEIPTS_PATH: receiptsPath
  };

  const proposed = runNode(scriptPath, [
    'propose',
    '--sandbox-id=sb_unit',
    '--target-path=systems/workflow/workflow_executor.ts',
    '--summary=adjust retry guard',
    '--risk=medium',
    '--recursion-depth=2'
  ], env, root);
  assert.strictEqual(proposed.status, 0, proposed.stderr || proposed.stdout);
  const proposedOut = parseJson(proposed, 'propose');
  assert.strictEqual(proposedOut.ok, true);
  assert.strictEqual(proposedOut.record.status, 'proposed');

  const mergeBlocked = runNode(scriptPath, [
    'merge',
    '--sandbox-id=sb_unit',
    '--approval-a=ops_a',
    '--approval-b=ops_b',
    '--apply=1'
  ], env, root);
  assert.notStrictEqual(mergeBlocked.status, 0, 'merge must fail before tests pass');
  const mergeBlockedOut = parseJson(mergeBlocked, 'merge_blocked');
  assert.strictEqual(mergeBlockedOut.ok, false);
  assert.ok(mergeBlockedOut.blocked.includes('tests_not_passed'));

  const tested = runNode(scriptPath, [
    'test',
    '--sandbox-id=sb_unit'
  ], env, root);
  assert.strictEqual(tested.status, 0, tested.stderr || tested.stdout);
  const testedOut = parseJson(tested, 'test');
  assert.strictEqual(testedOut.ok, true);
  assert.ok(Array.isArray(testedOut.results) && testedOut.results.length === 1);

  const merged = runNode(scriptPath, [
    'merge',
    '--sandbox-id=sb_unit',
    '--approval-a=ops_a',
    '--approval-b=ops_b',
    '--apply=1'
  ], env, root);
  assert.strictEqual(merged.status, 0, merged.stderr || merged.stdout);
  const mergedOut = parseJson(merged, 'merge');
  assert.strictEqual(mergedOut.ok, true);
  assert.strictEqual(mergedOut.blocked.length, 0);

  const rolled = runNode(scriptPath, [
    'rollback',
    '--sandbox-id=sb_unit',
    '--reason=post_merge_regression'
  ], env, root);
  assert.strictEqual(rolled.status, 0, rolled.stderr || rolled.stdout);
  const rolledOut = parseJson(rolled, 'rollback');
  assert.strictEqual(rolledOut.ok, true);
  assert.strictEqual(rolledOut.record.status, 'rolled_back');

  const status = runNode(scriptPath, ['status', '--sandbox-id=sb_unit'], env, root);
  assert.strictEqual(status.status, 0, status.stderr || status.stdout);
  const statusOut = parseJson(status, 'status');
  assert.strictEqual(statusOut.ok, true);
  assert.strictEqual(statusOut.record.status, 'rolled_back');

  writeJson(identityLatestPath, {
    checked: 12,
    blocked: 11,
    identity_drift_score: 0.58,
    max_identity_drift_score: 0.58
  });
  writeJson(preNeuralStatePath, {
    consent_state: 'paused',
    signals_total: 10,
    routed_total: 1,
    blocked_total: 8
  });
  writeJson(observerLatestPath, {
    observer: { mood: 'strained' },
    summary: {
      rates: {
        ship_rate: 0.2,
        hold_rate: 0.8
      }
    }
  });

  const blockedBySymbiosis = runNode(scriptPath, [
    'propose',
    '--sandbox-id=sb_blocked',
    '--target-path=systems/workflow/workflow_executor.ts',
    '--summary=attempt deep recursive mutation',
    '--risk=high',
    '--recursion-depth=9'
  ], env, root);
  assert.strictEqual(blockedBySymbiosis.status, 1, 'deep recursion should be blocked when symbiosis is low');
  const blockedOut = parseJson(blockedBySymbiosis, 'blocked');
  assert.strictEqual(blockedOut.ok, false);
  assert.strictEqual(String(blockedOut.error || ''), 'symbiosis_recursion_gate_blocked');

  const receipts = fs.existsSync(receiptsPath)
    ? fs.readFileSync(receiptsPath, 'utf8').split('\n').filter(Boolean)
    : [];
  assert.ok(receipts.length >= 4, 'expected propose/test/merge/rollback receipts');
}

run();
