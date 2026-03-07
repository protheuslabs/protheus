#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'autonomy', 'motivational_state_vector.js');

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
  return { status: Number(r.status || 0), payload: parsePayload(r.stdout), stderr: String(r.stderr || '') };
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'motivational-vector-test-'));
  const policyPath = path.join(tmp, 'policy.json');
  writeJson(policyPath, {
    enabled: true,
    advisory_only: true,
    receipts_path: path.join(tmp, 'state', 'receipts.jsonl'),
    latest_path: path.join(tmp, 'state', 'latest.json')
  });
  const env = { MOTIVATIONAL_STATE_VECTOR_POLICY_PATH: policyPath };

  let r = run(['evaluate', '--competence=0.7', '--caution=0.4', '--exploration=0.6', '--objective-id=obj_vec'], env);
  assert.strictEqual(r.status, 0, `evaluate should pass: ${r.stderr}`);
  assert.ok(r.payload && r.payload.ok === true, 'evaluate should be ok');
  assert.ok(r.payload.vector && Number.isFinite(Number(r.payload.vector.confidence || 0)), 'confidence should exist');

  r = run(['status'], env);
  assert.strictEqual(r.status, 0, `status should pass: ${r.stderr}`);
  assert.ok(r.payload && r.payload.ok === true, 'status should be ok');

  console.log('motivational_state_vector.test.js: OK');
}

try { main(); } catch (err) {
  console.error(`motivational_state_vector.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
