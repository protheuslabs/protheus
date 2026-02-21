#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

function mkDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function writeJson(filePath, obj) {
  mkDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), 'utf8');
}

function runScript(repoRoot, args, env) {
  const script = path.join(repoRoot, 'systems', 'autonomy', 'strategy_mode.js');
  return spawnSync('node', [script, ...args], { cwd: repoRoot, encoding: 'utf8', env });
}

function parseJson(stdout) {
  return JSON.parse(String(stdout || '{}'));
}

function issueLease(repoRoot, env, strategyId) {
  const leaseCli = path.join(repoRoot, 'systems', 'security', 'capability_lease.js');
  const r = spawnSync('node', [
    leaseCli,
    'issue',
    '--scope=strategy_mode_escalation',
    `--target=${strategyId}`,
    '--issued-by=strategy_mode_policy_root_test',
    '--reason=promote strategy mode'
  ], { cwd: repoRoot, encoding: 'utf8', env });
  assert.strictEqual(r.status, 0, `lease issue should pass: ${r.stderr}`);
  const out = parseJson(r.stdout);
  return String(out.token || '');
}

function run() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const tmpRoot = path.join(__dirname, 'temp_strategy_mode_policy_root');
  if (fs.existsSync(tmpRoot)) fs.rmSync(tmpRoot, { recursive: true, force: true });
  const strategyDir = path.join(tmpRoot, 'strategies');
  mkDir(strategyDir);
  const strategyPath = path.join(strategyDir, 'default.json');
  const logPath = path.join(tmpRoot, 'strategy_mode_changes.jsonl');

  writeJson(strategyPath, {
    version: '1.0',
    id: 'mode_policy_root_test',
    status: 'active',
    objective: { primary: 'test objective' },
    risk_policy: { allowed_risks: ['low'] },
    execution_policy: { mode: 'score_only' }
  });

  const env = {
    ...process.env,
    AUTONOMY_STRATEGY_DIR: strategyDir,
    AUTONOMY_STRATEGY_MODE_LOG: logPath,
    AUTONOMY_STRATEGY_MODE_REQUIRE_POLICY_ROOT: '1',
    AUTONOMY_STRATEGY_MODE_REQUIRE_SPC: '0',
    CAPABILITY_LEASE_KEY: 'test_mode_policy_root_secret',
    CAPABILITY_LEASE_STATE_PATH: path.join(tmpRoot, 'capability_leases.json'),
    CAPABILITY_LEASE_AUDIT_PATH: path.join(tmpRoot, 'capability_leases.jsonl'),
    POLICY_ROOT_AUDIT_PATH: path.join(tmpRoot, 'policy_root_decisions.jsonl')
  };

  let r = runScript(repoRoot, [
    'set',
    '--mode=canary_execute',
    '--approval-note=first promote to canary execute',
    '--approver-id=owner',
    '--second-approver-id=operator',
    '--second-approval-note=second approval first promote',
    '--force=1'
  ], env);
  assert.notStrictEqual(r.status, 0, 'set should fail without lease token');
  let out = parseJson(r.stdout);
  assert.strictEqual(out.error, 'policy_root_denied');
  assert.ok(out.policy_root && out.policy_root.reason === 'lease_token_required');

  const leaseToken = issueLease(repoRoot, env, 'mode_policy_root_test');
  assert.ok(leaseToken.length > 20, 'lease token expected');

  r = runScript(repoRoot, [
    'set',
    '--mode=canary_execute',
    '--approval-note=promote after valid lease',
    '--approver-id=owner',
    '--second-approver-id=operator',
    '--second-approval-note=second approval with lease',
    '--force=1',
    `--lease-token=${leaseToken}`
  ], env);
  assert.strictEqual(r.status, 0, `set should pass with lease token: ${r.stderr}`);
  out = parseJson(r.stdout);
  assert.strictEqual(out.result, 'mode_changed');
  assert.strictEqual(out.to_mode, 'canary_execute');
  assert.ok(out.policy_root && out.policy_root.decision === 'ALLOW');

  console.log('strategy_mode_policy_root.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`strategy_mode_policy_root.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
