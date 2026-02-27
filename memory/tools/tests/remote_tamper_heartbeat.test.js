#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'security', 'remote_tamper_heartbeat.js');

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeJson(filePath, payload) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-tamper-heartbeat-'));
  const policyPath = path.join(tmp, 'config', 'remote_tamper_heartbeat_policy.json');

  writeJson(policyPath, {
    schema_id: 'remote_tamper_heartbeat_policy',
    schema_version: '1.0-test',
    enabled: true,
    mode: 'enforce',
    heartbeat_interval_sec: 30,
    max_silence_sec: 600,
    integrity_probe_enabled: false,
    auto_quarantine_on_anomaly: true,
    signature_required: true,
    allow_auto_generated_local_key: true,
    static_watermark: 'test-watermark',
    identity_drift_allowed: false,
    secrets: {
      signing_key_env: 'PROTHEUS_HEARTBEAT_SIGNING_KEY',
      signing_key_path: path.join(tmp, 'state', 'security', 'remote_tamper_heartbeat', 'signing_key.txt')
    },
    paths: {
      state_path: path.join(tmp, 'state', 'security', 'remote_tamper_heartbeat', 'state.json'),
      latest_path: path.join(tmp, 'state', 'security', 'remote_tamper_heartbeat', 'latest.json'),
      outbox_path: path.join(tmp, 'state', 'security', 'remote_tamper_heartbeat', 'outbox.jsonl'),
      notifications_path: path.join(tmp, 'state', 'security', 'remote_tamper_heartbeat', 'notifications.jsonl'),
      quarantine_path: path.join(tmp, 'state', 'security', 'remote_tamper_heartbeat', 'quarantine.json'),
      evidence_dir: path.join(tmp, 'state', 'security', 'remote_tamper_heartbeat', 'evidence')
    }
  });

  const env = {
    REMOTE_TAMPER_HEARTBEAT_POLICY_PATH: policyPath,
    PROTHEUS_HEARTBEAT_SIGNING_KEY: 'test-signing-key'
  };

  let r = run(['emit', '--build-id=build_a', '--watermark=wm_a'], env);
  assert.strictEqual(r.status, 0, r.stderr || r.stdout || 'emit should pass');
  let payload = parseJson(r.stdout);
  assert.ok(payload && payload.ok === true, 'emit payload should be ok');
  assert.strictEqual(payload.anomaly, false, 'first heartbeat should establish trusted baseline');

  r = run(['verify', '--strict=1'], env);
  assert.strictEqual(r.status, 0, r.stderr || r.stdout || 'verify strict should pass');
  payload = parseJson(r.stdout);
  assert.ok(payload && payload.ok === true, 'verify payload should be ok');

  // Emit drifted identity to force anomaly + quarantine.
  r = run(['emit', '--build-id=build_b', '--watermark=wm_b'], env);
  assert.strictEqual(r.status, 0, r.stderr || r.stdout || 'anomalous emit should still write payload');
  payload = parseJson(r.stdout);
  assert.ok(payload && payload.anomaly === true, 'identity drift should produce anomaly');
  assert.strictEqual(payload.quarantine_active, true, 'anomaly should trigger quarantine');

  r = run(['status'], env);
  assert.strictEqual(r.status, 0, r.stderr || r.stdout || 'status should pass');
  payload = parseJson(r.stdout);
  assert.ok(payload && payload.quarantine && payload.quarantine.active === true, 'quarantine should remain active');

  r = run(['clear-quarantine', '--reason=test_release'], env);
  assert.strictEqual(r.status, 0, r.stderr || r.stdout || 'clear-quarantine should pass');
  payload = parseJson(r.stdout);
  assert.ok(payload && payload.ok === true, 'clear payload should be ok');

  r = run(['status'], env);
  payload = parseJson(r.stdout);
  assert.ok(payload && payload.quarantine && payload.quarantine.active === false, 'quarantine should clear');

  const notificationsPath = path.join(tmp, 'state', 'security', 'remote_tamper_heartbeat', 'notifications.jsonl');
  assert.ok(fs.existsSync(notificationsPath), 'notifications should exist');
  const notificationRows = fs.readFileSync(notificationsPath, 'utf8').split('\n').filter(Boolean);
  assert.ok(notificationRows.length >= 2, 'should emit multiple notifications');

  console.log('remote_tamper_heartbeat.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`remote_tamper_heartbeat.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
