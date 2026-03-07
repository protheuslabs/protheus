#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'binary_runtime_hardening.js');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function run(args) {
  const res = spawnSync('node', [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8' });
  let payload = null;
  try { payload = JSON.parse(String(res.stdout || '').trim()); } catch {}
  return { status: res.status == null ? 1 : res.status, payload, stderr: String(res.stderr || '') };
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'binary-runtime-hardening-'));
  const stateRoot = path.join(tmp, 'state');
  const policyPath = path.join(tmp, 'config', 'binary_runtime_hardening_policy.json');
  const soulPath = path.join(stateRoot, 'security', 'soul_token_guard.json');

  writeJson(soulPath, { token: 'soul_test_token' });

  writeJson(policyPath, {
    version: '1.0',
    enabled: true,
    shadow_only: true,
    paths: {
      state_path: path.join(stateRoot, 'ops', 'binary_runtime_hardening', 'state.json'),
      latest_path: path.join(stateRoot, 'ops', 'binary_runtime_hardening', 'latest.json'),
      receipts_path: path.join(stateRoot, 'ops', 'binary_runtime_hardening', 'receipts.jsonl'),
      artifacts_path: path.join(stateRoot, 'ops', 'binary_runtime_hardening', 'artifacts.json'),
      debug_sessions_path: path.join(stateRoot, 'ops', 'binary_runtime_hardening', 'debug_sessions.json'),
      soul_guard_path: soulPath
    }
  });

  let res = run(['role-bootstrap', `--policy=${policyPath}`, '--role=child', '--instance-id=node-a', '--apply=1']);
  assert.strictEqual(res.status, 0, `role-bootstrap should pass: ${res.stderr}`);
  assert.strictEqual(res.payload.runtime_mode, 'binary');

  res = run(['build-obfuscation', `--policy=${policyPath}`, '--tier=hard', '--target=linux-x64', '--apply=1']);
  assert.strictEqual(res.status, 0, `build-obfuscation should pass: ${res.stderr}`);
  assert.ok(res.payload.artifact_hash, 'artifact hash expected');

  res = run(['debug-attest', `--policy=${policyPath}`, '--soul-token=soul_test_token', '--session-ttl-sec=300', '--apply=1']);
  assert.strictEqual(res.status, 0, `debug-attest should pass: ${res.stderr}`);
  assert.ok(res.payload.session_id, 'session id expected');

  res = run(['tamper-check', `--policy=${policyPath}`, '--strict=1', '--apply=1']);
  assert.strictEqual(res.status, 0, `tamper-check should pass when hashes aligned: ${res.stderr}`);
  assert.strictEqual(res.payload.tamper, false);

  res = run(['reweave-stage', `--policy=${policyPath}`, '--stage=apply', '--version=v1.2.0', '--apply=1']);
  assert.strictEqual(res.status, 0, `reweave-stage apply should pass: ${res.stderr}`);

  res = run(['status', `--policy=${policyPath}`]);
  assert.strictEqual(res.status, 0, `status should pass: ${res.stderr}`);
  assert.ok(res.payload && res.payload.state && res.payload.state.current_version === 'v1.2.0');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('binary_runtime_hardening.test.js: OK');
} catch (err) {
  console.error(`binary_runtime_hardening.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
