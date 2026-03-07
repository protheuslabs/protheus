#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'primitives', 'cognitive_control_primitive.js');

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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cognitive-control-test-'));
  const policyPath = path.join(tmp, 'policy.json');
  writeJson(policyPath, {
    enabled: true,
    shadow_only: true,
    min_sufficiency: 0.6,
    max_retrieval_items: 4,
    receipts_path: path.join(tmp, 'state', 'receipts.jsonl'),
    latest_path: path.join(tmp, 'state', 'latest.json')
  });
  const env = { COGNITIVE_CONTROL_POLICY_PATH: policyPath };

  let r = run(['run', '--query=investigate execution gap', '--objective-id=obj_xai', '--sufficiency=0.4', '--retrieval-count=3'], env);
  assert.strictEqual(r.status, 0, `run should pass: ${r.stderr}`);
  assert.ok(r.payload && r.payload.ok === true, 'run should be ok');
  assert.strictEqual(r.payload.stages.retrieve.item_count, 3, 'retrieval count should be 3');

  r = run(['status'], env);
  assert.strictEqual(r.status, 0, `status should pass: ${r.stderr}`);
  assert.ok(r.payload && r.payload.ok === true, 'status should be ok');

  console.log('cognitive_control_primitive.test.js: OK');
}

try { main(); } catch (err) {
  console.error(`cognitive_control_primitive.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
