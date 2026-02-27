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

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    shadow_only: false,
    max_active_sandboxes: 8,
    required_approvals: 2,
    require_tests_before_merge: true,
    sandbox_branch_prefix: 'codex/evo/',
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
    '--risk=medium'
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

  const receipts = fs.existsSync(receiptsPath)
    ? fs.readFileSync(receiptsPath, 'utf8').split('\n').filter(Boolean)
    : [];
  assert.ok(receipts.length >= 4, 'expected propose/test/merge/rollback receipts');
}

run();
