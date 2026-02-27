#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'profile_compatibility_gate.js');

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

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

function run(args, env = {}) {
  const proc = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env }
  });
  return {
    status: typeof proc.status === 'number' ? proc.status : 1,
    stdout: String(proc.stdout || ''),
    stderr: String(proc.stderr || '')
  };
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-compat-'));
  const policyPath = path.join(tmp, 'policy.json');
  const profileSchemaPath = path.join(tmp, 'capability_profile_schema.json');
  const primitiveCatalogPath = path.join(tmp, 'primitive_catalog.json');
  const profileDir = path.join(tmp, 'profiles');
  const statePath = path.join(tmp, 'state', 'latest.json');
  const historyPath = path.join(tmp, 'state', 'history.jsonl');
  ensureDir(profileDir);

  writeJson(policyPath, {
    schema_id: 'profile_compatibility_policy',
    schema_version: '1.0',
    enabled: true,
    max_minor_behind: 2,
    profile_schema_path: profileSchemaPath,
    profile_dir: profileDir,
    primitive_catalog_path: primitiveCatalogPath,
    state_path: statePath,
    history_path: historyPath
  });
  writeJson(profileSchemaPath, { schema_version: '1.4' });
  writeJson(primitiveCatalogPath, { schema_version: '1.2' });

  writeJson(path.join(profileDir, 'ok_a.json'), { schema_version: '1.4' });
  writeJson(path.join(profileDir, 'ok_b.json'), { schema_version: '1.2' });
  writeJson(path.join(profileDir, 'bad.json'), { schema_version: '1.1' });

  const env = { PROFILE_COMPATIBILITY_POLICY_PATH: policyPath };

  const failRun = run(['run', '--strict=1'], env);
  assert.notStrictEqual(failRun.status, 0, '1.1 should be outside N-2 window from 1.4');
  const failPayload = parseJson(failRun.stdout);
  assert.strictEqual(failPayload.ok, false);
  assert.ok(Array.isArray(failPayload.failures) && failPayload.failures.length >= 1);

  writeJson(path.join(profileDir, 'bad.json'), { schema_version: '1.3' });
  const passRun = run(['run', '--strict=1'], env);
  assert.strictEqual(passRun.status, 0, passRun.stderr || passRun.stdout);
  const passPayload = parseJson(passRun.stdout);
  assert.strictEqual(passPayload.ok, true);
  assert.strictEqual(Number(passPayload.checked_profiles || 0), 3);

  const status = run(['status'], env);
  assert.strictEqual(status.status, 0, status.stderr || status.stdout);
  const statusPayload = parseJson(status.stdout);
  assert.strictEqual(statusPayload.ok, true);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('profile_compatibility_gate.test.js: OK');
} catch (err) {
  console.error(`profile_compatibility_gate.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
