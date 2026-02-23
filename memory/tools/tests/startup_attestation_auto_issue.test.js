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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'startup-attestation-auto-issue-'));
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
  assert.strictEqual(r.status, 0, `initial issue should pass: ${r.stderr}`);
  assert.ok(r.payload && r.payload.ok === true, 'initial issue should be ok');

  // Force critical_hash_drift path.
  writeText(critical, '{"v":2}\n');
  r = run(['verify'], env);
  assert.strictEqual(r.status, 0, 'non-strict verify should return payload even on drift');
  assert.ok(r.payload && r.payload.ok === false, 'verify after drift should fail');
  assert.strictEqual(String(r.payload.reason || ''), 'critical_hash_drift', 'expected critical_hash_drift reason');

  // Emulate spine auto-issue contract: allowed reasons trigger issue + re-verify.
  const autoIssueReasons = new Set(['attestation_missing_or_invalid', 'attestation_stale', 'critical_hash_drift']);
  assert.ok(autoIssueReasons.has(String(r.payload.reason || '')), 'drift reason must be auto-issue eligible');

  r = run(['issue'], env);
  assert.strictEqual(r.status, 0, `auto-issue should pass: ${r.stderr}`);
  assert.ok(r.payload && r.payload.ok === true, 'auto-issue should emit ok');

  r = run(['verify', '--strict'], env);
  assert.strictEqual(r.status, 0, `verify after auto-issue should pass: ${r.stderr}`);
  assert.ok(r.payload && r.payload.ok === true, 'verify after auto-issue should be ok');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('startup_attestation_auto_issue.test.js: OK');
} catch (err) {
  console.error(`startup_attestation_auto_issue.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

