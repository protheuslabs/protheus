#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function write(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function writeJson(filePath, value) {
  write(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function parseJson(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function run(script, cwd, args, env) {
  const r = spawnSync(process.execPath, [script, ...args], {
    cwd,
    env,
    encoding: 'utf8'
  });
  return {
    status: Number(r.status || 0),
    stdout: String(r.stdout || ''),
    stderr: String(r.stderr || ''),
    payload: parseJson(r.stdout)
  };
}

function main() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const script = path.join(repoRoot, 'systems', 'continuity', 'resurrection_protocol.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'resurrection-protocol-'));
  const policyPath = path.join(tmp, 'config', 'resurrection_protocol_policy.json');

  const sourceVaultPath = path.join(tmp, 'state', 'continuity', 'vault', 'latest.json');
  const sourceHelixPolicyPath = path.join(tmp, 'config', 'helix_policy.json');
  writeJson(sourceVaultPath, { checkpoint: 'cp_1', value: 'original' });
  writeJson(sourceHelixPolicyPath, { version: '1.0', codex: { codex_path: 'codex.helix' } });

  writeJson(policyPath, {
    schema_id: 'resurrection_protocol_policy',
    schema_version: '1.0',
    enabled: true,
    key_env: 'RESURRECTION_PROTOCOL_KEY',
    key_min_length: 24,
    default_shards: 3,
    max_shards: 8,
    allow_missing_sources: true,
    sources: [
      { path: 'state/continuity/vault/latest.json', required: true },
      { path: 'client/config/helix_policy.json', required: true }
    ],
    state: {
      index_path: path.join(tmp, 'state', 'continuity', 'resurrection', 'index.json'),
      bundles_dir: path.join(tmp, 'state', 'continuity', 'resurrection', 'bundles'),
      recovery_dir: path.join(tmp, 'state', 'continuity', 'resurrection', 'recovery'),
      receipts_path: path.join(tmp, 'state', 'continuity', 'resurrection', 'receipts.jsonl')
    }
  });

  const env = {
    ...process.env,
    RESURRECTION_ROOT: tmp,
    RESURRECTION_POLICY_PATH: policyPath,
    RESURRECTION_PROTOCOL_KEY: 'test_resurrection_key_material_123456789'
  };

  const bundle = run(script, repoRoot, [
    'bundle',
    '--bundle-id=seed_01',
    '--shards=3',
    '--target-host=host_a',
    `--policy=${policyPath}`
  ], env);
  assert.strictEqual(bundle.status, 0, bundle.stderr || 'bundle should pass');
  assert.ok(bundle.payload && bundle.payload.ok === true, 'bundle payload should be ok');
  assert.strictEqual(String(bundle.payload.bundle_id || ''), 'seed_01', 'bundle id should be stable');
  assert.ok(String(bundle.payload.restore_token || '').length > 20, 'restore token should be emitted');

  const verify = run(script, repoRoot, [
    'verify',
    '--bundle-id=seed_01',
    '--strict=1',
    `--policy=${policyPath}`
  ], env);
  assert.strictEqual(verify.status, 0, verify.stderr || 'verify should pass');
  assert.ok(verify.payload && verify.payload.ok === true, 'verify payload should be ok');

  // Simulate corrupted live file before restore.
  writeJson(sourceVaultPath, { checkpoint: 'cp_1', value: 'corrupted' });

  const restore = run(script, repoRoot, [
    'restore',
    '--bundle-id=seed_01',
    '--target-host=host_a',
    `--attestation-token=${bundle.payload.restore_token}`,
    '--apply=1',
    `--policy=${policyPath}`
  ], env);
  assert.strictEqual(restore.status, 0, restore.stderr || 'restore should pass');
  assert.ok(restore.payload && restore.payload.ok === true, 'restore payload should be ok');
  assert.strictEqual(restore.payload.apply, true, 'restore should apply');
  assert.ok(Array.isArray(restore.payload.backups), 'restore should emit backup paths');

  const restoredVault = JSON.parse(fs.readFileSync(sourceVaultPath, 'utf8'));
  assert.strictEqual(restoredVault.value, 'original', 'restore should rehydrate original vault content');

  const status = run(script, repoRoot, ['status', `--policy=${policyPath}`], env);
  assert.strictEqual(status.status, 0, status.stderr || 'status should pass');
  assert.ok(status.payload && status.payload.ok === true, 'status payload should be ok');
  assert.ok(Number(status.payload.bundle_count || 0) >= 1, 'status should include at least one bundle');

  console.log('resurrection_protocol.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`resurrection_protocol.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
