#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'crypto', 'fhe_encrypted_compute_pilot.js');

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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fhe-pilot-'));
  const policyPath = path.join(tmp, 'config', 'fhe_encrypted_compute_policy.json');
  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    strict_default: true,
    allowlisted_operations: ['sum', 'mean'],
    event_stream: { enabled: false, publish: false, stream: 'crypto.fhe_pilot' },
    paths: {
      memory_dir: path.join(tmp, 'memory', 'crypto', 'fhe'),
      adaptive_index_path: path.join(tmp, 'adaptive', 'crypto', 'fhe', 'index.json'),
      events_path: path.join(tmp, 'state', 'crypto', 'fhe_pilot', 'events.jsonl'),
      latest_path: path.join(tmp, 'state', 'crypto', 'fhe_pilot', 'latest.json'),
      receipts_path: path.join(tmp, 'state', 'crypto', 'fhe_pilot', 'receipts.jsonl')
    }
  });

  let out = run(['configure', '--owner=jay', '--operator=bfv', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  out = run(['compute', '--owner=jay', '--operation=sum', '--payload=encrypted_blob', '--risk-tier=2', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.strictEqual(out.payload.event, 'fhe_compute');
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('fhe_encrypted_compute_pilot.test.js: OK');
} catch (err) {
  console.error(`fhe_encrypted_compute_pilot.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
