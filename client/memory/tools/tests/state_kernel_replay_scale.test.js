#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const KERNEL = path.join(ROOT, 'systems', 'ops', 'state_kernel.js');

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function run(args, env = {}) {
  const r = spawnSync(process.execPath, [KERNEL, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8'
  });
  return { status: Number(r.status || 0), stdout: String(r.stdout || ''), stderr: String(r.stderr || '') };
}

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

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'state-kernel-replay-scale-'));
  const helixLatest = path.join(tmp, 'state', 'helix', 'latest.json');
  const policyPath = path.join(tmp, 'config', 'state_kernel_policy.json');

  writeJson(helixLatest, { ts: new Date().toISOString(), attestation_decision: 'clear' });
  writeJson(policyPath, {
    enabled: true,
    sqlite: {
      db_path: path.join(tmp, 'state', 'kernel', 'state_kernel.db'),
      journal_mode: 'WAL',
      synchronous: 'FULL',
      foreign_keys: true,
      busy_timeout_ms: 5000
    },
    immutable: {
      events_path: path.join(tmp, 'state', 'kernel', 'events.jsonl'),
      receipts_path: path.join(tmp, 'state', 'kernel', 'receipts.jsonl'),
      parity_path: path.join(tmp, 'state', 'kernel', 'parity.json')
    },
    outputs: {
      latest_path: path.join(tmp, 'state', 'kernel', 'latest.json'),
      migration_receipts_path: path.join(tmp, 'state', 'kernel', 'migrations.receipts.jsonl'),
      replay_reports_path: path.join(tmp, 'state', 'kernel', 'replay_reports.jsonl')
    },
    attestation: {
      enforce_on_write: true,
      helix_latest_path: helixLatest,
      max_staleness_sec: 3600,
      allowed_decisions: ['clear']
    }
  });

  const env = { STATE_KERNEL_POLICY_PATH: policyPath };

  let r = run(['migrate', '--strict=1'], env);
  assert.strictEqual(r.status, 0, r.stderr || r.stdout || 'migrate should pass');

  for (let i = 0; i < 5; i += 1) {
    r = run(['organ-set', `--organ-id=organ_${i}`, `--state-json={"idx":${i},"ok":true}`], env);
    assert.strictEqual(r.status, 0, r.stderr || r.stdout || `organ-set ${i} should pass`);
  }
  for (let i = 0; i < 6; i += 1) {
    r = run(['queue-enqueue', '--queue-name=scale', `--payload-json={"idx":${i}}`, '--priority=1'], env);
    assert.strictEqual(r.status, 0, r.stderr || r.stdout || `queue-enqueue ${i} should pass`);
  }

  r = run(['replay-verify', '--profiles=phone,desktop,cluster'], env);
  assert.strictEqual(r.status, 0, r.stderr || r.stdout || 'replay verify should pass');
  const payload = parseJson(r.stdout);
  assert.ok(payload && payload.ok === true, 'replay payload should be ok');
  assert.strictEqual(payload.deterministic, true, 'replay should be deterministic across profiles');
  assert.ok(Array.isArray(payload.profiles) && payload.profiles.length === 3, 'three profile replay reports expected');

  console.log('state_kernel_replay_scale.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`state_kernel_replay_scale.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
