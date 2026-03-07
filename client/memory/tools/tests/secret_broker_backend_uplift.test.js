#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'security', 'secret_broker.js');

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

function run(args, env) {
  const proc = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8'
  });
  return {
    status: Number.isFinite(proc.status) ? Number(proc.status) : 1,
    stdout: String(proc.stdout || ''),
    stderr: String(proc.stderr || ''),
    payload: parseJson(proc.stdout)
  };
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-broker-uplift-'));
  const policyPath = path.join(tmp, 'config', 'secret_broker_policy.json');
  const statePath = path.join(tmp, 'state', 'security', 'secret_broker_state.json');
  const auditPath = path.join(tmp, 'state', 'security', 'secret_broker_audit.jsonl');
  const agePayloadPath = path.join(tmp, 'secrets', 'demo_age_payload.json');

  writeJson(agePayloadPath, {
    value: 'AGE_FILE_SECRET',
    rotated_at: '2026-03-01T00:00:00Z'
  });

  writeJson(policyPath, {
    version: '1.0-test',
    rotation_policy: {
      warn_after_days: 45,
      max_after_days: 90,
      require_rotated_at: false,
      enforce_on_issue: false
    },
    secrets: {
      demo_keychain: {
        providers: [
          {
            type: 'keychain',
            enabled: true,
            service: 'protheus.demo.keychain',
            account: 'default',
            command: ['/client/bin/sh', '-lc', 'printf "{\\"value\\":\\"KEYCHAIN_SECRET\\",\\"rotated_at\\":\\"2026-03-01T00:00:00Z\\"}"'],
            parse_json: true,
            value_path: 'value',
            rotated_at_path: 'rotated_at'
          },
          {
            type: 'env',
            env: 'DEMO_KEYCHAIN_FALLBACK'
          }
        ]
      },
      demo_age: {
        providers: [
          {
            type: 'age_file',
            enabled: true,
            paths: [agePayloadPath],
            decrypt_command: ['/client/bin/sh', '-lc', 'cat "$SECRET_FILE_PATH"'],
            parse_json: true,
            value_path: 'value',
            rotated_at_path: 'rotated_at'
          },
          {
            type: 'env',
            env: 'DEMO_AGE_FALLBACK'
          }
        ]
      }
    }
  });

  const env = {
    SECRET_BROKER_POLICY_PATH: policyPath,
    SECRET_BROKER_STATE_PATH: statePath,
    SECRET_BROKER_AUDIT_PATH: auditPath,
    SECRET_BROKER_KEY: 'demo_secret_broker_key',
    DEMO_KEYCHAIN_FALLBACK: 'ENV_FALLBACK_KEYCHAIN',
    DEMO_AGE_FALLBACK: 'ENV_FALLBACK_AGE'
  };

  let out = run(['issue', '--secret-id=demo_keychain', '--scope=ops', '--caller=test', '--ttl-sec=120', `--policy=${policyPath}`], env);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.ok === true, 'keychain issue should succeed');
  const handleKeychain = out.payload.handle;

  out = run(['resolve', `--handle=${handleKeychain}`, '--scope=ops', '--caller=test', '--reveal=1', `--policy=${policyPath}`], env);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.strictEqual(out.payload.value, 'KEYCHAIN_SECRET', 'keychain provider should supply value');
  assert.strictEqual(out.payload.backend.provider_type, 'keychain', 'backend type should be keychain');

  out = run(['issue', '--secret-id=demo_age', '--scope=ops', '--caller=test', '--ttl-sec=120', `--policy=${policyPath}`], env);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.ok === true, 'age issue should succeed');
  const handleAge = out.payload.handle;

  out = run(['resolve', `--handle=${handleAge}`, '--scope=ops', '--caller=test', '--reveal=1', `--policy=${policyPath}`], env);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.strictEqual(out.payload.value, 'AGE_FILE_SECRET', 'age_file provider should supply value');
  assert.strictEqual(out.payload.backend.provider_type, 'age_file', 'backend type should be age_file');

  out = run(['rotation-check', '--secret-ids=demo_keychain,demo_age', '--strict=1', `--policy=${policyPath}`], env);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.ok === true, 'rotation check should pass for uplift providers');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('secret_broker_backend_uplift.test.js: OK');
} catch (err) {
  console.error(`secret_broker_backend_uplift.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
