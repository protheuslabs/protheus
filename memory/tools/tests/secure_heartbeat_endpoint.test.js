#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'security', 'secure_heartbeat_endpoint.js');

function parseJson(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function run(args, env = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env }
  });
  return { status: r.status, payload: parseJson(r.stdout), stdout: r.stdout, stderr: r.stderr };
}

function sign(secret, ts, payloadText) {
  return crypto.createHmac('sha256', String(secret || '')).update(`${ts}.${payloadText}`, 'utf8').digest('hex');
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'secure-heartbeat-endpoint-'));
  const runbookPath = path.join(tmp, 'docs', 'OPERATOR_RUNBOOK.md');
  fs.mkdirSync(path.dirname(runbookPath), { recursive: true });
  fs.writeFileSync(runbookPath, 'node systems/security/secure_heartbeat_endpoint.js verify --strict=1\n', 'utf8');

  const policyPath = path.join(tmp, 'config', 'secure_heartbeat_endpoint_policy.json');
  writeJson(policyPath, {
    schema_id: 'secure_heartbeat_endpoint_policy',
    schema_version: '1.0',
    enabled: true,
    auth: {
      required: true,
      max_clock_skew_sec: 120,
      rotate_previous_on_issue: true,
      default_key_ttl_hours: 12,
      max_key_ttl_hours: 24
    },
    rate_limit: {
      window_sec: 60,
      max_requests_per_window: 1
    },
    paths: {
      keys_path: path.join(tmp, 'state', 'security', 'secure_heartbeat_endpoint', 'keys.json'),
      state_path: path.join(tmp, 'state', 'security', 'secure_heartbeat_endpoint', 'state.json'),
      latest_path: path.join(tmp, 'state', 'security', 'secure_heartbeat_endpoint', 'latest.json'),
      audit_path: path.join(tmp, 'state', 'security', 'secure_heartbeat_endpoint', 'audit.jsonl'),
      alerts_path: path.join(tmp, 'state', 'security', 'secure_heartbeat_endpoint', 'alerts.jsonl')
    },
    alerting: {
      emit_security_alerts: true,
      runbook_path: runbookPath,
      severity_on_invalid_signature: 'high',
      severity_on_rate_limit: 'medium'
    }
  });

  const env = { SECURE_HEARTBEAT_ENDPOINT_POLICY_PATH: policyPath };

  let out = run(['issue-key', '--client-id=primary'], env);
  assert.strictEqual(out.status, 0, out.stderr || 'issue-key should pass');
  assert.ok(out.payload && out.payload.ok === true, 'issue-key payload should pass');
  const keyId = out.payload.key_id;
  const secret = out.payload.secret;
  assert.ok(keyId && secret, 'key_id + secret must be returned');

  const payloadText = JSON.stringify({ heartbeat_id: 'hb_1', ts: '2026-02-27T00:00:00.000Z', instance_id: 'node_a' });
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = sign(secret, ts, payloadText);
  out = run([
    'receive',
    `--payload-json=${payloadText}`,
    `--key-id=${keyId}`,
    `--ts=${ts}`,
    `--signature=${sig}`,
    '--ip=127.0.0.1'
  ], env);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout || 'first receive should pass');
  assert.ok(out.payload && out.payload.ok === true, 'first receive should be accepted');

  const ts2 = String(Math.floor(Date.now() / 1000));
  const sig2 = sign(secret, ts2, payloadText);
  out = run([
    'receive',
    `--payload-json=${payloadText}`,
    `--key-id=${keyId}`,
    `--ts=${ts2}`,
    `--signature=${sig2}`
  ], env);
  assert.notStrictEqual(out.status, 0, 'second receive should be denied by rate limit');
  assert.ok(out.payload && out.payload.ok === false, 'second receive should fail');
  assert.ok(Array.isArray(out.payload.reasons) && out.payload.reasons.includes('rate_limited'));

  out = run(['issue-key', '--client-id=primary'], env);
  assert.strictEqual(out.status, 0, out.stderr || 'rotated issue-key should pass');
  const rotated = out.payload;
  assert.ok(rotated && rotated.ok === true);
  assert.notStrictEqual(rotated.key_id, keyId, 'rotated key should be new id');

  const ts3 = String(Math.floor(Date.now() / 1000));
  const sig3 = sign(secret, ts3, payloadText);
  out = run([
    'receive',
    `--payload-json=${payloadText}`,
    `--key-id=${keyId}`,
    `--ts=${ts3}`,
    `--signature=${sig3}`
  ], env);
  assert.notStrictEqual(out.status, 0, 'old rotated key should be rejected');
  assert.ok(out.payload && out.payload.ok === false);
  assert.ok(
    Array.isArray(out.payload.reasons) && (out.payload.reasons.includes('key_not_active') || out.payload.reasons.includes('key_expired')),
    'expected revoked/expired key rejection'
  );

  out = run(['verify', '--strict=1'], env);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout || 'verify --strict should pass');
  assert.ok(out.payload && out.payload.ok === true, 'verify payload should pass');

  out = run(['status'], env);
  assert.strictEqual(out.status, 0, out.stderr || 'status should pass');
  assert.ok(out.payload && out.payload.ok === true);
  assert.ok(out.payload.key_counts && Number(out.payload.key_counts.total || 0) >= 2);

  console.log('secure_heartbeat_endpoint.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`secure_heartbeat_endpoint.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

