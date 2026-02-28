#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'memory', 'dynamic_memory_embedding_adapter.js');

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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dynamic-embedding-test-'));
  const policyPath = path.join(tmp, 'policy.json');
  writeJson(policyPath, {
    enabled: true,
    shadow_only: true,
    max_updates_per_session: 3,
    receipts_path: path.join(tmp, 'state', 'receipts.jsonl'),
    sessions_path: path.join(tmp, 'state', 'sessions.json'),
    latest_path: path.join(tmp, 'state', 'latest.json')
  });
  const env = { DYNAMIC_MEMORY_EMBEDDING_POLICY_PATH: policyPath };

  let r = run(['adapt', '--session-id=s1', '--text=first vector payload'], env);
  assert.strictEqual(r.status, 0, `adapt should pass: ${r.stderr}`);
  assert.ok(r.payload && r.payload.ok === true, 'adapt should be ok');
  assert.strictEqual(r.payload.update_count, 1, 'update count should be 1');

  r = run(['status'], env);
  assert.strictEqual(r.status, 0, `status should pass: ${r.stderr}`);
  assert.ok(r.payload && r.payload.ok === true, 'status should be ok');
  assert.strictEqual(r.payload.sessions.total, 1, 'one session expected');

  console.log('dynamic_memory_embedding_adapter.test.js: OK');
}

try { main(); } catch (err) {
  console.error(`dynamic_memory_embedding_adapter.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
