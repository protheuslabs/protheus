#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

function mkDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function parseJson(stdout) {
  return JSON.parse(String(stdout || '{}'));
}

function run() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const tmpRoot = path.join(__dirname, 'temp_policy_rootd_lease');
  if (fs.existsSync(tmpRoot)) fs.rmSync(tmpRoot, { recursive: true, force: true });
  mkDir(tmpRoot);

  const env = {
    ...process.env,
    CAPABILITY_LEASE_KEY: 'test_policy_root_secret',
    CAPABILITY_LEASE_STATE_PATH: path.join(tmpRoot, 'capability_leases.json'),
    CAPABILITY_LEASE_AUDIT_PATH: path.join(tmpRoot, 'capability_leases.jsonl'),
    POLICY_ROOT_AUDIT_PATH: path.join(tmpRoot, 'policy_root_decisions.jsonl')
  };

  const leaseCli = path.join(repoRoot, 'systems', 'security', 'capability_lease.js');
  const policyCli = path.join(repoRoot, 'systems', 'security', 'policy_rootd.js');

  let r = spawnSync('node', [
    policyCli,
    'authorize',
    '--scope=strategy_mode_escalation',
    '--target=test_strategy',
    '--approval-note=manual approval from test'
  ], { cwd: repoRoot, encoding: 'utf8', env });
  assert.notStrictEqual(r.status, 0, 'missing lease token should be denied');
  let out = parseJson(r.stdout);
  assert.strictEqual(out.reason, 'lease_token_required');

  r = spawnSync('node', [
    policyCli,
    'authorize',
    '--scope=autonomy_self_change_apply',
    '--target=commit:abc123',
    '--approval-note=manual approval from test'
  ], { cwd: repoRoot, encoding: 'utf8', env });
  assert.notStrictEqual(r.status, 0, 'self-change scope should require lease token');
  out = parseJson(r.stdout);
  assert.strictEqual(out.reason, 'lease_token_required');

  r = spawnSync('node', [
    leaseCli,
    'issue',
    '--scope=strategy_mode_escalation',
    '--target=test_strategy',
    '--ttl-sec=300',
    '--issued-by=test_suite',
    '--reason=policy root integration test'
  ], { cwd: repoRoot, encoding: 'utf8', env });
  assert.strictEqual(r.status, 0, `lease issue should pass: ${r.stderr}`);
  out = parseJson(r.stdout);
  const token = String(out.token || '');
  assert.ok(token.length > 20, 'issued token should be present');

  r = spawnSync('node', [
    policyCli,
    'authorize',
    '--scope=strategy_mode_escalation',
    '--target=test_strategy',
    '--approval-note=manual approval from test',
    `--lease-token=${token}`
  ], { cwd: repoRoot, encoding: 'utf8', env });
  assert.strictEqual(r.status, 0, `policy root authorize should pass: ${r.stderr}`);
  out = parseJson(r.stdout);
  assert.strictEqual(out.decision, 'ALLOW');
  assert.strictEqual(out.reason, 'lease_verified');

  r = spawnSync('node', [
    policyCli,
    'authorize',
    '--scope=strategy_mode_escalation',
    '--target=test_strategy',
    '--approval-note=manual approval from test',
    `--lease-token=${token}`
  ], { cwd: repoRoot, encoding: 'utf8', env });
  assert.notStrictEqual(r.status, 0, 'consumed lease should be denied on reuse');
  out = parseJson(r.stdout);
  assert.strictEqual(out.reason, 'lease_already_consumed');

  console.log('policy_rootd_lease.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`policy_rootd_lease.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
