#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'security', 'organ_state_encryption_plane.js');

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeJson(filePath, payload) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function writeText(filePath, text) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, String(text), 'utf8');
}

function run(args, env) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8'
  });
}

function parseJson(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const lines = text.split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'organ-state-encryption-'));
  const policyPath = path.join(tmp, 'config', 'organ_state_encryption_policy.json');
  const keyringPath = path.join(tmp, 'state', 'security', 'organ_state_encryption', 'keyring.json');
  const auditPath = path.join(tmp, 'state', 'security', 'organ_state_encryption', 'audit.jsonl');
  const alertsPath = path.join(tmp, 'state', 'ops', 'system_health', 'events.jsonl');

  const stateRoot = path.join(tmp, 'state');
  const memoryRoot = path.join(tmp, 'memory');
  const cryonicsRoot = path.join(tmp, 'state', '_cryonics');
  ensureDir(stateRoot);
  ensureDir(memoryRoot);
  ensureDir(cryonicsRoot);

  writeJson(policyPath, {
    schema_id: 'organ_state_encryption_policy',
    schema_version: '1.0-test',
    enabled: true,
    unauthorized_fail_closed: true,
    max_rotation_age_days: 3650,
    crypto: {
      cipher: 'aes-256-gcm',
      key_bytes: 32,
      iv_bytes: 12,
      mac: 'hmac-sha256'
    },
    paths: {
      keyring_path: keyringPath,
      audit_path: auditPath,
      alerts_path: alertsPath
    },
    lane_roots: {
      state: stateRoot,
      memory: memoryRoot,
      cryonics: cryonicsRoot
    },
    organs: {
      workflow: { lanes: ['state'] },
      memory: { lanes: ['memory', 'state'] },
      cryonics: { lanes: ['cryonics', 'state'] },
      sensory: { lanes: ['state'] }
    }
  });

  const source = path.join(stateRoot, 'workflow', 'sample.json');
  const envelope = `${source}.enc.json`;
  const restored = path.join(stateRoot, 'workflow', 'sample.restored.json');
  writeText(source, JSON.stringify({ ok: true, value: 42 }));

  const env = { ORGAN_STATE_ENCRYPTION_POLICY_PATH: policyPath };

  let r = run(['encrypt', '--organ=workflow', '--lane=state', `--source=${source}`, `--out=${envelope}`], env);
  assert.strictEqual(r.status, 0, r.stderr || r.stdout || 'encrypt should pass');
  let payload = parseJson(r.stdout);
  assert.ok(payload && payload.ok === true, 'encrypt payload should be ok');
  assert.strictEqual(Number(payload.key_version || 0), 1, 'initial key version should be 1');
  assert.ok(fs.existsSync(envelope), 'envelope should exist');

  r = run(['decrypt', '--organ=workflow', `--cipher=${envelope}`, `--out=${restored}`], env);
  assert.strictEqual(r.status, 0, r.stderr || r.stdout || 'decrypt should pass');
  payload = parseJson(r.stdout);
  assert.ok(payload && payload.ok === true, 'decrypt payload should be ok');
  assert.strictEqual(fs.readFileSync(restored, 'utf8'), fs.readFileSync(source, 'utf8'), 'restored payload should match source');

  r = run(['rotate-key', '--organ=workflow', '--reason=test_rotation'], env);
  assert.strictEqual(r.status, 0, r.stderr || r.stdout || 'rotate-key should pass');
  payload = parseJson(r.stdout);
  assert.ok(payload && payload.ok === true, 'rotate payload should be ok');
  assert.strictEqual(Number(payload.to_version || 0), 2, 'rotation should bump key version');

  // Unauthorized decrypt with wrong organ must fail closed and emit alert.
  const wrongOut = path.join(stateRoot, 'workflow', 'wrong-organ.json');
  r = run(['decrypt', '--organ=sensory', `--cipher=${envelope}`, `--out=${wrongOut}`], env);
  assert.notStrictEqual(r.status, 0, 'decrypt with wrong organ should fail closed');
  payload = parseJson(r.stdout);
  assert.ok(payload && payload.ok === false, 'wrong-organ decrypt should return failure payload');
  assert.ok(String(payload.reason || '').includes('unauthorized_decrypt_attempt'), 'unauthorized reason must be surfaced');
  assert.ok(fs.existsSync(alertsPath), 'alerts path should be written');
  const alertsRaw = fs.readFileSync(alertsPath, 'utf8').trim().split('\n').filter(Boolean);
  assert.ok(alertsRaw.length >= 1, 'at least one alert row expected');

  r = run(['verify', '--strict=1'], env);
  assert.strictEqual(r.status, 0, r.stderr || r.stdout || 'verify strict should pass');
  payload = parseJson(r.stdout);
  assert.ok(payload && payload.ok === true, 'verify payload should be ok');

  r = run(['status'], env);
  assert.strictEqual(r.status, 0, r.stderr || r.stdout || 'status should pass');
  payload = parseJson(r.stdout);
  assert.ok(payload && payload.type === 'organ_state_encryption_status', 'status payload type mismatch');

  console.log('organ_state_encryption_plane.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`organ_state_encryption_plane.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
