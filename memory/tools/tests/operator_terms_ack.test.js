#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'security', 'operator_terms_ack.js');

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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'operator-terms-ack-'));
  const tosPath = path.join(tmp, 'TERMS_OF_SERVICE.md');
  const eulaPath = path.join(tmp, 'EULA.md');
  fs.writeFileSync(tosPath, '# Terms of Service\nVersion: `2026-02-27.v1`\n', 'utf8');
  fs.writeFileSync(eulaPath, '# End User License Agreement\nVersion: `2026-02-27.v1`\n', 'utf8');

  const policyPath = path.join(tmp, 'config', 'operator_terms_ack_policy.json');
  writeJson(policyPath, {
    schema_id: 'operator_terms_ack_policy',
    schema_version: '1.0',
    enabled: true,
    enforce_on_install: true,
    current_terms_version: '2026-02-27.v1',
    paths: {
      tos_path: tosPath,
      eula_path: eulaPath,
      state_path: path.join(tmp, 'state', 'security', 'operator_terms_ack', 'state.json'),
      latest_path: path.join(tmp, 'state', 'security', 'operator_terms_ack', 'latest.json'),
      receipts_path: path.join(tmp, 'state', 'security', 'operator_terms_ack', 'receipts.jsonl')
    }
  });

  const env = { OPERATOR_TERMS_ACK_POLICY_PATH: policyPath };

  let out = run(['check'], env);
  assert.strictEqual(out.status, 0, out.stderr || 'check should return payload');
  assert.ok(out.payload && out.payload.ok === false, 'check should fail before acceptance');
  assert.ok(Array.isArray(out.payload.reasons) && out.payload.reasons.includes('operator_ack_missing'));

  out = run(['accept', '--operator-id=test_operator', '--approval-note=unit_test'], env);
  assert.strictEqual(out.status, 0, out.stderr || 'accept should pass');
  assert.ok(out.payload && out.payload.ok === true, 'accept should succeed');

  out = run(['check', '--strict=1'], env);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout || 'strict check should pass after accept');
  assert.ok(out.payload && out.payload.ok === true, 'check should pass after acceptance');

  fs.writeFileSync(tosPath, '# Terms of Service\nVersion: `2026-02-27.v1`\nchanged\n', 'utf8');
  out = run(['check', '--strict=1'], env);
  assert.notStrictEqual(out.status, 0, 'strict check should fail on changed terms digest');
  assert.ok(out.payload && out.payload.ok === false);
  assert.ok(Array.isArray(out.payload.reasons) && out.payload.reasons.includes('tos_digest_mismatch'));

  console.log('operator_terms_ack.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`operator_terms_ack.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

