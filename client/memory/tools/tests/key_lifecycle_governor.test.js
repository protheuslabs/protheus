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

function runCmd(script, root, args, env) {
  const r = spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    env,
    encoding: 'utf8'
  });
  return {
    status: r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    payload: parseJson(r.stdout)
  };
}

function main() {
  const root = path.resolve(__dirname, '..', '..', '..');
  const script = path.join(root, 'systems', 'security', 'key_lifecycle_governor.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'key-lifecycle-'));

  const policyPath = path.join(tmp, 'config', 'key_lifecycle_policy.json');
  const contractPath = path.join(tmp, 'config', 'crypto_agility_contract.json');
  const statePath = path.join(tmp, 'state', 'key_lifecycle', 'state.json');
  const receiptsPath = path.join(tmp, 'state', 'key_lifecycle', 'receipts.jsonl');

  writeJson(contractPath, {
    schema_id: 'crypto_agility_contract',
    schema_version: '1.0',
    migration_tracks: {
      ed25519: { target: 'pq-dilithium3', status: 'planned' },
      'pq-dilithium3': { target: 'pq-dilithium3', status: 'active' },
      'rsa-4096': { target: 'pq-dilithium3', status: 'planned' }
    }
  });

  writeJson(policyPath, {
    schema_id: 'key_lifecycle_policy',
    schema_version: '1.0',
    enabled: true,
    default_algorithm: 'ed25519',
    allowed_algorithms: ['ed25519', 'rsa-4096', 'pq-dilithium3'],
    key_classes: ['signing', 'encryption', 'transport'],
    hardware_required_classes: ['signing'],
    min_recovery_shards: 3,
    drill_max_age_days: 30,
    state_path: statePath,
    receipts_path: receiptsPath,
    crypto_agility_contract_path: contractPath
  });

  const env = { ...process.env };

  const issue = runCmd(script, root, [
    'issue',
    '--key-id=signing_root',
    '--class=signing',
    '--hardware-backed=1',
    `--policy=${policyPath}`
  ], env);
  assert.strictEqual(issue.status, 0, issue.stderr || 'issue should pass');
  assert.ok(issue.payload && issue.payload.ok === true, 'issue payload should be ok');

  const rotate = runCmd(script, root, [
    'rotate',
    '--key-id=signing_root',
    '--algorithm=pq-dilithium3',
    '--hardware-backed=1',
    `--policy=${policyPath}`
  ], env);
  assert.strictEqual(rotate.status, 0, rotate.stderr || 'rotate should pass');
  assert.ok(rotate.payload && rotate.payload.ok === true, 'rotate payload should be ok');
  assert.strictEqual(Number(rotate.payload.to_version || 0), 2, 'rotation should bump version to 2');

  const drill = runCmd(script, root, [
    'drill',
    '--key-id=signing_root',
    `--policy=${policyPath}`
  ], env);
  assert.strictEqual(drill.status, 0, drill.stderr || 'drill should pass');
  assert.ok(drill.payload && drill.payload.ok === true, 'drill payload should be ok');

  const verify = runCmd(script, root, [
    'verify',
    '--strict=1',
    `--policy=${policyPath}`
  ], env);
  assert.strictEqual(verify.status, 0, verify.stderr || 'verify strict should pass');
  assert.ok(verify.payload && verify.payload.ok === true, 'verify payload should be ok');

  const revoke = runCmd(script, root, [
    'revoke',
    '--key-id=signing_root',
    `--policy=${policyPath}`
  ], env);
  assert.strictEqual(revoke.status, 0, revoke.stderr || 'revoke should pass');

  const recover = runCmd(script, root, [
    'recover',
    '--key-id=signing_root',
    '--approval-note=test_recover',
    `--policy=${policyPath}`
  ], env);
  assert.strictEqual(recover.status, 0, recover.stderr || 'recover should pass');

  const status = runCmd(script, root, [
    'status',
    `--policy=${policyPath}`
  ], env);
  assert.strictEqual(status.status, 0, status.stderr || 'status should pass');
  assert.ok(status.payload && status.payload.ok === true, 'status payload should be ok');
  assert.ok(status.payload.keys && status.payload.keys.signing_root, 'status should include key record');

  const receiptLines = fs.readFileSync(receiptsPath, 'utf8').split('\n').filter(Boolean);
  assert.ok(receiptLines.length >= 5, 'expected lifecycle receipts');

  console.log('key_lifecycle_governor.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`key_lifecycle_governor.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
