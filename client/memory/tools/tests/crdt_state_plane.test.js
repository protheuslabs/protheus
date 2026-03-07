#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'pinnacle', 'crdt_state_plane.js');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function parseJson(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function run(args) {
  const proc = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  return {
    status: Number.isFinite(proc.status) ? Number(proc.status) : 1,
    stdout: String(proc.stdout || ''),
    stderr: String(proc.stderr || ''),
    payload: parseJson(proc.stdout)
  };
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crdt-plane-'));
  const policyPath = path.join(tmp, 'config', 'crdt_state_plane_policy.json');
  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    strict_default: true,
    event_stream: { enabled: false, publish: false, stream: 'pinnacle.crdt_state_plane' },
    paths: {
      memory_dir: path.join(tmp, 'memory', 'crdt'),
      adaptive_index_path: path.join(tmp, 'adaptive', 'crdt', 'index.json'),
      events_path: path.join(tmp, 'state', 'pinnacle', 'crdt_state_plane', 'events.jsonl'),
      latest_path: path.join(tmp, 'state', 'pinnacle', 'crdt_state_plane', 'latest.json'),
      receipts_path: path.join(tmp, 'state', 'pinnacle', 'crdt_state_plane', 'receipts.jsonl')
    }
  });

  let out = run(['configure', '--owner=jay', '--domain=soul', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  out = run(['reconcile', '--owner=jay', '--domain=memory', '--risk-tier=2', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.strictEqual(out.payload.event, 'crdt_reconcile');
  assert.ok(fs.existsSync(path.join(tmp, 'state', 'pinnacle', 'crdt_state_plane', 'events.jsonl')));
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('crdt_state_plane.test.js: OK');
} catch (err) {
  console.error(`crdt_state_plane.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
