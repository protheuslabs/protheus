#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'workflow', 'account_creation_profile_extension.js');

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function parsePayload(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function run(args, env = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8'
  });
  return {
    status: Number(r.status || 0),
    payload: parsePayload(r.stdout),
    stderr: String(r.stderr || '')
  };
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'account-profile-ext-test-'));
  const templatesPath = path.join(tmp, 'templates.json');
  const policyPath = path.join(tmp, 'policy.json');
  const outputRoot = path.join(tmp, 'profiles');

  writeJson(templatesPath, {
    templates: [
      { id: 'upwork_basic', name: 'Upwork Basic', provider: 'upwork' },
      { id: 'email_basic', name: 'Email Basic', provider: 'email' }
    ]
  });
  writeJson(policyPath, {
    enabled: true,
    templates_path: templatesPath,
    output_profiles_root: outputRoot,
    required_primitives: ['desktop_ui', 'alias_verification_vault'],
    receipts_path: path.join(tmp, 'state', 'receipts.jsonl'),
    latest_path: path.join(tmp, 'state', 'latest.json')
  });

  const env = {
    ACCOUNT_CREATION_PROFILE_EXTENSION_POLICY_PATH: policyPath
  };

  let r = run(['compile'], env);
  assert.strictEqual(r.status, 0, `compile should pass: ${r.stderr}`);
  assert.ok(r.payload && r.payload.ok === true, 'compile should succeed');
  assert.strictEqual(r.payload.compiled_count, 2, 'two profiles should compile');
  for (const row of r.payload.compiled) {
    const abs = path.join(ROOT, row.profile_path);
    assert.ok(fs.existsSync(abs), `compiled profile missing: ${row.profile_path}`);
  }

  r = run(['status'], env);
  assert.strictEqual(r.status, 0, `status should pass: ${r.stderr}`);
  assert.ok(r.payload && r.payload.ok === true, 'status should be ok');

  console.log('account_creation_profile_extension.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`account_creation_profile_extension.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
