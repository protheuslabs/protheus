#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const KERNEL = path.join(ROOT, 'systems', 'ops', 'state_kernel.js');
const CUTOVER = path.join(ROOT, 'systems', 'ops', 'state_kernel_cutover.js');

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function run(script, args, env = {}) {
  const r = spawnSync(process.execPath, [script, ...args], {
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'state-kernel-cutover-'));
  const helixLatest = path.join(tmp, 'state', 'helix', 'latest.json');
  const kernelPolicy = path.join(tmp, 'config', 'state_kernel_policy.json');
  const cutoverPolicy = path.join(tmp, 'config', 'state_kernel_cutover_policy.json');

  writeJson(helixLatest, { ts: new Date().toISOString(), attestation_decision: 'clear' });
  writeJson(kernelPolicy, {
    version: '1.0-test',
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

  writeJson(cutoverPolicy, {
    version: '1.0-test',
    enabled: true,
    strict_default: true,
    phases: ['dual_write', 'read_cutover', 'legacy_retired'],
    default_mode: 'dual_write',
    shadow_validation_days: 1,
    require_parity_ok: true,
    state_path: path.join(tmp, 'state', 'ops', 'state_kernel_cutover', 'state.json'),
    history_path: path.join(tmp, 'state', 'ops', 'state_kernel_cutover', 'history.jsonl'),
    latest_path: path.join(tmp, 'state', 'ops', 'state_kernel_cutover', 'latest.json')
  });

  const env = {
    STATE_KERNEL_POLICY_PATH: kernelPolicy,
    STATE_KERNEL_CUTOVER_POLICY_PATH: cutoverPolicy
  };

  let r = run(KERNEL, ['migrate', '--strict=1'], env);
  assert.strictEqual(r.status, 0, r.stderr || r.stdout || 'kernel migrate should pass');

  r = run(KERNEL, ['organ-set', '--organ-id=spine', '--state-json={"ok":true}'], env);
  assert.strictEqual(r.status, 0, r.stderr || r.stdout || 'organ-set should pass');

  r = run(CUTOVER, ['status'], env);
  assert.strictEqual(r.status, 0, r.stderr || r.stdout || 'cutover status should pass');
  let payload = parseJson(r.stdout);
  assert.ok(payload && payload.ok === true, 'cutover status payload should be ok');
  assert.strictEqual(payload.state.mode, 'dual_write');

  r = run(CUTOVER, ['set-mode', '--mode=read_cutover'], env);
  assert.strictEqual(r.status, 0, r.stderr || r.stdout || 'set-mode read_cutover should pass');

  const statePath = JSON.parse(fs.readFileSync(cutoverPolicy, 'utf8')).state_path;
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const old = new Date(Date.now() - (2 * 24 * 60 * 60 * 1000)).toISOString();
  state.first_read_cutover_at = old;
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');

  r = run(CUTOVER, ['tick', '--apply-retire=1'], env);
  assert.strictEqual(r.status, 0, r.stderr || r.stdout || 'tick apply-retire should pass');
  payload = parseJson(r.stdout);
  assert.ok(payload && payload.ok === true, 'tick payload should be ok');

  r = run(CUTOVER, ['status'], env);
  assert.strictEqual(r.status, 0, r.stderr || r.stdout || 'status should pass');
  payload = parseJson(r.stdout);
  assert.ok(payload && payload.ok === true, 'status payload should be ok');
  assert.strictEqual(payload.state.mode, 'legacy_retired', 'mode should retire after validation window');

  console.log('state_kernel_cutover.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`state_kernel_cutover.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
