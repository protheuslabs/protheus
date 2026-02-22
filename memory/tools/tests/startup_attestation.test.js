#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'security', 'startup_attestation.js');

function mkdirp(p) { fs.mkdirSync(p, { recursive: true }); }
function writeJson(p, obj) { mkdirp(path.dirname(p)); fs.writeFileSync(p, JSON.stringify(obj, null, 2)); }
function writeText(p, s) { mkdirp(path.dirname(p)); fs.writeFileSync(p, s, 'utf8'); }

function run(args, env) {
  const r = spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
  let payload = null;
  try { payload = JSON.parse(String(r.stdout || '').trim()); } catch {}
  return { status: r.status ?? 0, payload, stderr: String(r.stderr || '') };
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'startup-attestation-'));
  const root = path.join(tmp, 'repo');
  mkdirp(root);
  const critical = path.join(root, 'config', 'critical.json');
  writeText(critical, '{"v":1}\n');

  const policyPath = path.join(root, 'config', 'startup_attestation_policy.json');
  writeJson(policyPath, {
    version: '1.0',
    ttl_hours: 24,
    critical_paths: ['config/critical.json']
  });

  const statePath = path.join(root, 'state', 'security', 'startup_attestation.json');
  const auditPath = path.join(root, 'state', 'security', 'startup_attestation_audit.jsonl');
  const env = {
    STARTUP_ATTESTATION_ROOT: root,
    STARTUP_ATTESTATION_POLICY_PATH: policyPath,
    STARTUP_ATTESTATION_STATE_PATH: statePath,
    STARTUP_ATTESTATION_AUDIT_PATH: auditPath,
    STARTUP_ATTESTATION_KEY: 'test_attestation_key'
  };

  let r = run(['issue', '--strict'], env);
  assert.strictEqual(r.status, 0, `issue should pass: ${r.stderr}`);
  assert.ok(r.payload && r.payload.ok === true, 'issue ok expected');

  r = run(['verify', '--strict'], env);
  assert.strictEqual(r.status, 0, `verify should pass: ${r.stderr}`);
  assert.ok(r.payload && r.payload.ok === true, 'verify ok expected');

  writeText(critical, '{"v":2}\n');
  r = run(['verify', '--strict'], env);
  assert.strictEqual(r.status, 1, 'verify should fail after critical drift');
  assert.ok(r.payload && r.payload.ok === false, 'verify drift should set ok=false');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('startup_attestation.test.js: OK');
} catch (err) {
  console.error(`startup_attestation.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
