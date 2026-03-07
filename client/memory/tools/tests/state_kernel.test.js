#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'state_kernel.js');

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function run(args, env = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8'
  });
  return {
    status: Number(r.status || 0),
    stdout: String(r.stdout || ''),
    stderr: String(r.stderr || '')
  };
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'state-kernel-test-'));
  const helixLatest = path.join(tmp, 'state', 'helix', 'latest.json');
  const policyPath = path.join(tmp, 'config', 'state_kernel_policy.json');

  writeJson(helixLatest, {
    ts: new Date().toISOString(),
    attestation_decision: 'clear'
  });

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    shadow_only: false,
    strict_default: true,
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
      allowed_decisions: ['clear', 'shadow_advisory_clear']
    },
    context_paths: {
      soul_token_path: path.join(tmp, 'state', 'security', 'soul_token_guard.json'),
      soul_biometric_path: path.join(tmp, 'state', 'security', 'soul_biometric', 'latest.json'),
      identity_anchor_path: path.join(tmp, 'state', 'autonomy', 'identity_anchor', 'latest.json'),
      heroic_echo_path: path.join(tmp, 'state', 'autonomy', 'echo', 'latest.json')
    },
    migration: { strict_fail_on_unknown: true }
  });

  const env = { STATE_KERNEL_POLICY_PATH: policyPath };

  let r = run(['migrate', '--strict=1'], env);
  assert.strictEqual(r.status, 0, r.stderr || r.stdout || 'migrate should pass');
  let payload = parseJson(r.stdout);
  assert.ok(payload && payload.ok === true, 'migrate payload should be ok');

  r = run(['organ-set', '--organ-id=spine', '--state-json={"phase":"run","ok":true}'], env);
  assert.strictEqual(r.status, 0, r.stderr || r.stdout || 'organ-set should pass');
  payload = parseJson(r.stdout);
  assert.ok(payload && payload.ok === true, 'organ-set payload should be ok');

  r = run(['organ-get', '--organ-id=spine'], env);
  assert.strictEqual(r.status, 0, r.stderr || r.stdout || 'organ-get should pass');
  payload = parseJson(r.stdout);
  assert.ok(payload && payload.ok === true, 'organ-get payload should be ok');
  assert.strictEqual(payload.row.state.phase, 'run');

  r = run(['queue-enqueue', '--queue-name=autonomy', '--payload-json={"job":"x"}', '--priority=5'], env);
  assert.strictEqual(r.status, 0, r.stderr || r.stdout || 'queue-enqueue should pass');
  payload = parseJson(r.stdout);
  assert.ok(payload && payload.ok === true, 'queue enqueue payload should be ok');
  const queueId = payload.queue_id;

  r = run(['queue-claim', '--queue-name=autonomy', '--lease-owner=test_worker', '--limit=1', '--lease-seconds=120'], env);
  assert.strictEqual(r.status, 0, r.stderr || r.stdout || 'queue-claim should pass');
  payload = parseJson(r.stdout);
  assert.ok(payload && payload.ok === true, 'queue claim payload should be ok');
  assert.ok(Array.isArray(payload.claimed) && payload.claimed.length === 1, 'one task should be claimed');

  r = run(['queue-heartbeat', `--queue-id=${queueId}`, '--lease-owner=test_worker', '--lease-seconds=120'], env);
  assert.strictEqual(r.status, 0, r.stderr || r.stdout || 'queue-heartbeat should pass');
  payload = parseJson(r.stdout);
  assert.ok(payload && payload.ok === true, 'queue heartbeat payload should be ok');

  r = run(['queue-complete', `--queue-id=${queueId}`], env);
  assert.strictEqual(r.status, 0, r.stderr || r.stdout || 'queue-complete should pass');
  payload = parseJson(r.stdout);
  assert.ok(payload && payload.ok === true, 'queue complete payload should be ok');

  r = run(['proposal-upsert', '--proposal-id=p1', '--objective-id=obj1', '--payload-json={"title":"x"}', '--status=draft', '--clearance=2'], env);
  assert.strictEqual(r.status, 0, r.stderr || r.stdout || 'proposal-upsert should pass');
  payload = parseJson(r.stdout);
  assert.ok(payload && payload.ok === true, 'proposal upsert payload should be ok');

  r = run(['proposal-approve', '--proposal-id=p1', '--actor-id=ops', '--decision=approve', '--note=looks_good'], env);
  assert.strictEqual(r.status, 0, r.stderr || r.stdout || 'proposal-approve should pass');
  payload = parseJson(r.stdout);
  assert.ok(payload && payload.ok === true, 'proposal approve payload should be ok');

  r = run(['checkpoint-create', '--checkpoint-id=c1', '--run-id=r1', '--lane=autonomy', '--snapshot-json={"checkpoint":1}'], env);
  assert.strictEqual(r.status, 0, r.stderr || r.stdout || 'checkpoint-create should pass');
  payload = parseJson(r.stdout);
  assert.ok(payload && payload.ok === true, 'checkpoint create payload should be ok');

  r = run(['verify-parity'], env);
  assert.strictEqual(r.status, 0, r.stderr || r.stdout || 'verify-parity should pass');
  payload = parseJson(r.stdout);
  assert.ok(payload && payload.ok === true, 'parity command should run');
  assert.strictEqual(payload.parity.ok, true, 'parity should be true');

  r = run(['status'], env);
  assert.strictEqual(r.status, 0, r.stderr || r.stdout || 'status should pass');
  payload = parseJson(r.stdout);
  assert.ok(payload && payload.ok === true, 'status payload should be ok');
  assert.ok(payload.counts && Number(payload.counts.immutable_events || 0) >= 5, 'immutable event count should be non-trivial');

  console.log('state_kernel.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`state_kernel.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
