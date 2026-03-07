#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'identity', 'did_vc_binding.js');

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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'did-vc-'));
  const policyPath = path.join(tmp, 'config', 'did_vc_binding_policy.json');
  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    strict_default: true,
    event_stream: { enabled: false, publish: false, stream: 'identity.did_vc' },
    paths: {
      memory_dir: path.join(tmp, 'memory', 'identity', 'did'),
      adaptive_index_path: path.join(tmp, 'adaptive', 'identity', 'did', 'index.json'),
      events_path: path.join(tmp, 'state', 'identity', 'did_vc', 'events.jsonl'),
      latest_path: path.join(tmp, 'state', 'identity', 'did_vc', 'latest.json'),
      receipts_path: path.join(tmp, 'state', 'identity', 'did_vc', 'receipts.jsonl')
    }
  });

  let out = run(['configure', '--owner=jay', '--did=did:key:zjay', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  out = run(['issue', '--owner=jay', '--subject=seed_alpha', '--claim=builder_badge', '--risk-tier=2', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.strictEqual(out.payload.event, 'did_vc_issue');
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('did_vc_binding.test.js: OK');
} catch (err) {
  console.error(`did_vc_binding.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
