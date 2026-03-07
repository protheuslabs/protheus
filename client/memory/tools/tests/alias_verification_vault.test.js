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

function assertOk(proc, label) {
  assert.strictEqual(proc.status, 0, `${label} failed: ${proc.stderr || proc.stdout}`);
  const out = parseJson(proc, label);
  assert.strictEqual(out.ok, true, `${label} expected ok=true`);
  return out;
}

function run() {
  const root = path.resolve(__dirname, '..', '..', '..');
  const script = path.join(root, 'systems', 'security', 'alias_verification_vault.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alias-vault-'));
  const policyPath = path.join(tmp, 'config', 'alias_verification_vault_policy.json');
  const stateRoot = path.join(tmp, 'state', 'security', 'alias_verification_vault');

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    shadow_only: false,
    key_env: 'ALIAS_VERIFICATION_VAULT_KEY',
    key_min_length: 16,
    default_ttl_hours: 24,
    code_ttl_minutes: 60,
    cleanup_retention_hours: 1,
    channels: {
      email: { domain: 'test.local', prefix: 'ax' },
      sms: { prefix: '+1555888' }
    },
    state: {
      root: stateRoot,
      index_path: path.join(stateRoot, 'index.json'),
      latest_path: path.join(stateRoot, 'latest.json'),
      receipts_path: path.join(stateRoot, 'receipts.jsonl')
    },
    redaction: {
      show_plaintext_codes_by_default: false
    }
  });

  const env = {
    ...process.env,
    ALIAS_VERIFICATION_VAULT_POLICY_PATH: policyPath,
    ALIAS_VERIFICATION_VAULT_KEY: 'alias-vault-test-key'
  };

  const issued = assertOk(runNode(script, [
    'issue',
    '--channel=email',
    '--purpose=signup',
    '--passport-id=passport_abc',
    '--apply=1'
  ], env, root), 'issue');
  assert.ok(issued.alias && issued.alias.alias_id, 'alias should be returned');
  assert.ok(String(issued.alias.address || '').includes('@test.local'), 'alias email domain should match policy');

  const aliasId = issued.alias.alias_id;
  const routed = assertOk(runNode(script, [
    'route-code',
    `--alias-id=${aliasId}`,
    '--code=123456',
    '--source=test_harness',
    '--apply=1'
  ], env, root), 'route-code');
  assert.ok(routed.code_hash, 'code hash should be emitted');

  const consumedHidden = assertOk(runNode(script, [
    'consume-code',
    `--alias-id=${aliasId}`,
    '--apply=1'
  ], env, root), 'consume-code hidden');
  assert.strictEqual(consumedHidden.found, true);
  assert.strictEqual(consumedHidden.code, '***', 'default consume should redact code');

  const routedAgain = assertOk(runNode(script, [
    'route-code',
    `--alias-id=${aliasId}`,
    '--code=777999',
    '--source=test_harness',
    '--apply=1'
  ], env, root), 'route-code second');
  assert.ok(routedAgain.code_hash, 'second code hash should be emitted');

  const consumedRevealed = assertOk(runNode(script, [
    'consume-code',
    `--alias-id=${aliasId}`,
    '--reveal=1',
    '--apply=1'
  ], env, root), 'consume-code reveal');
  assert.strictEqual(consumedRevealed.code, '777999', 'revealed consume should return plaintext code');

  const revoked = assertOk(runNode(script, [
    'revoke',
    `--alias-id=${aliasId}`,
    '--reason=finished',
    '--apply=1'
  ], env, root), 'revoke');
  assert.strictEqual(revoked.status, 'revoked');

  const status = assertOk(runNode(script, [
    'status',
    `--alias-id=${aliasId}`
  ], env, root), 'status');
  assert.ok(status.alias, 'status alias missing');
  assert.strictEqual(status.alias.status, 'revoked', 'alias status should be revoked');

  const cleanup = assertOk(runNode(script, [
    'cleanup',
    '--apply=1',
    '--now=2099-01-01T00:00:00.000Z'
  ], env, root), 'cleanup');
  assert.ok(Number(cleanup.pruned_codes || 0) >= 1, 'cleanup should prune aged code entries');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('alias_verification_vault.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`alias_verification_vault.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
