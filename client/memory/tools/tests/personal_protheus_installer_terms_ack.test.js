#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'personal_protheus_installer.js');

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

function run(args, env) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env }
  });
  return { status: r.status, payload: parseJson(r.stdout), stdout: r.stdout, stderr: r.stderr };
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'personal-installer-terms-'));
  const stateDir = path.join(tmp, 'state');
  const policyPath = path.join(tmp, 'config', 'operator_terms_ack_policy.json');
  const tosPath = path.join(tmp, 'TERMS_OF_SERVICE.md');
  const eulaPath = path.join(tmp, 'EULA.md');
  fs.writeFileSync(tosPath, '# Terms of Service\nVersion: `2026-02-27.v1`\n', 'utf8');
  fs.writeFileSync(eulaPath, '# End User License Agreement\nVersion: `2026-02-27.v1`\n', 'utf8');
  writeJson(policyPath, {
    schema_id: 'operator_terms_ack_policy',
    schema_version: '1.0',
    enabled: true,
    enforce_on_install: true,
    current_terms_version: '2026-02-27.v1',
    paths: {
      tos_path: tosPath,
      eula_path: eulaPath,
      state_path: path.join(stateDir, 'security', 'operator_terms_ack', 'state.json'),
      latest_path: path.join(stateDir, 'security', 'operator_terms_ack', 'latest.json'),
      receipts_path: path.join(stateDir, 'security', 'operator_terms_ack', 'receipts.jsonl')
    }
  });

  const env = {
    OPERATOR_TERMS_ACK_POLICY_PATH: policyPath,
    PERSONAL_PROTHEUS_STATE_DIR: path.join(stateDir, 'ops', 'personal_protheus')
  };

  let out = run(['install'], env);
  assert.notStrictEqual(out.status, 0, 'install should fail before terms acknowledgment');
  assert.ok(out.payload && out.payload.error === 'operator_terms_ack_required', 'expected terms gate failure');

  out = run([
    'install',
    '--accept-terms=1',
    '--operator-id=test_operator',
    '--approval-note=installer_test'
  ], env);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout || 'install should pass after terms acceptance');
  assert.ok(out.payload && out.payload.ok === true, 'install payload should be ok');
  assert.ok(out.payload.terms && out.payload.terms.accepted === true, 'terms should be accepted');

  out = run(['status'], env);
  assert.strictEqual(out.status, 0, out.stderr || 'status should pass');
  assert.ok(out.payload && out.payload.ok === true);
  assert.ok(out.payload.terms && out.payload.terms.accepted === true, 'status should reflect accepted terms');

  console.log('personal_protheus_installer_terms_ack.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`personal_protheus_installer_terms_ack.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

