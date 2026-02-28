#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'lib', 'passport_iteration_chain.js');

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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'passport-chain-test-'));
  const chainPath = path.join(tmp, 'chain.jsonl');
  const latestPath = path.join(tmp, 'latest.json');
  const env = {
    PASSPORT_ITERATION_CHAIN_PATH: chainPath,
    PASSPORT_ITERATION_CHAIN_LATEST_PATH: latestPath
  };

  let r = run([
    'record',
    '--lane=iterative_repair',
    '--step=reproduce',
    '--iteration=1',
    '--objective-id=obj_1',
    '--target-path=systems/workflow/workflow_executor.ts',
    '--metadata-json={"status":"ok"}'
  ], env);
  assert.strictEqual(r.status, 0, `record 1 failed: ${r.stderr}`);
  assert.ok(r.payload && r.payload.ok === true, 'record 1 should succeed');
  assert.strictEqual(r.payload.seq, 1, 'first seq should be 1');

  r = run([
    'record',
    '--lane=iterative_repair',
    '--step=verify',
    '--iteration=1',
    '--objective-id=obj_1',
    '--target-path=systems/workflow/workflow_executor.ts',
    '--metadata-json={"status":"ok","verified":true}'
  ], env);
  assert.strictEqual(r.status, 0, `record 2 failed: ${r.stderr}`);
  assert.ok(r.payload && r.payload.ok === true, 'record 2 should succeed');
  assert.strictEqual(r.payload.seq, 2, 'second seq should be 2');

  r = run(['status'], env);
  assert.strictEqual(r.status, 0, `status failed: ${r.stderr}`);
  assert.ok(r.payload && r.payload.ok === true, 'status should succeed');
  assert.strictEqual(r.payload.total_events, 2, 'total events should be 2');

  console.log('passport_iteration_chain.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`passport_iteration_chain.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
