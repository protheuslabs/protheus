#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'actuation', 'sub_executor_synthesis.js');

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function run(args, env = {}) {
  const proc = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env }
  });
  return {
    status: typeof proc.status === 'number' ? proc.status : 1,
    stdout: String(proc.stdout || ''),
    stderr: String(proc.stderr || '')
  };
}

function parseJson(stdout) {
  const lines = String(stdout || '').trim().split('\n').map((row) => row.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i]);
    } catch {
      // continue
    }
  }
  return null;
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'subexec-synth-'));
  const policyPath = path.join(tmp, 'policy.json');
  const statePath = path.join(tmp, 'state', 'state.json');
  const receiptsPath = path.join(tmp, 'state', 'receipts.jsonl');
  const distillDir = path.join(tmp, 'distilled');
  writeJson(policyPath, {
    version: '1.0',
    enabled: true,
    default_ttl_sec: 1,
    max_active_candidates: 8,
    allow_high_risk: false,
    dedupe_window_sec: 600,
    validation: {
      require_nursery_pass: true,
      require_adversarial_pass: true
    },
    state_path: statePath,
    receipts_path: receiptsPath,
    distill_dir: distillDir
  });

  const env = { SUB_EXECUTOR_SYNTHESIS_POLICY_PATH: policyPath };

  const first = run([
    'propose',
    '--profile-id=cap_alpha',
    '--intent=write_file',
    '--failure-reason=executor_failed_missing_param'
  ], env);
  assert.strictEqual(first.status, 0, first.stderr || first.stdout);
  const firstPayload = parseJson(first.stdout);
  assert.strictEqual(firstPayload.ok, true);
  assert.strictEqual(firstPayload.reused, false);
  const candidateId = String(firstPayload.candidate && firstPayload.candidate.candidate_id || '');
  assert.ok(candidateId, 'candidate id should exist');

  const reuse = run([
    'propose',
    '--profile-id=cap_alpha',
    '--intent=write_file',
    '--failure-reason=executor_failed_missing_param'
  ], env);
  assert.strictEqual(reuse.status, 0, reuse.stderr || reuse.stdout);
  const reusePayload = parseJson(reuse.stdout);
  assert.strictEqual(reusePayload.ok, true);
  assert.strictEqual(reusePayload.reused, true, 'second propose should dedupe');
  assert.strictEqual(String(reusePayload.candidate.candidate_id), candidateId);

  const rejectEval = run(['evaluate', `--candidate-id=${candidateId}`], env);
  assert.notStrictEqual(rejectEval.status, 0, 'evaluation without lanes should fail');
  const rejectPayload = parseJson(rejectEval.stdout);
  assert.strictEqual(rejectPayload.ok, false);

  const passEval = run([
    'evaluate',
    `--candidate-id=${candidateId}`,
    '--nursery-pass=1',
    '--adversarial-pass=1',
    '--evidence={"lane":"test"}'
  ], env);
  assert.strictEqual(passEval.status, 0, passEval.stderr || passEval.stdout);
  const passPayload = parseJson(passEval.stdout);
  assert.strictEqual(passPayload.ok, true);
  assert.strictEqual(String(passPayload.candidate.status), 'validated');

  const distill = run(['distill', `--candidate-id=${candidateId}`], env);
  assert.strictEqual(distill.status, 0, distill.stderr || distill.stdout);
  const distillPayload = parseJson(distill.stdout);
  assert.strictEqual(distillPayload.ok, true);
  assert.strictEqual(String(distillPayload.candidate.status), 'distilled');
  const distilledPath = path.join(ROOT, String(distillPayload.candidate.distilled_path || ''));
  assert.ok(fs.existsSync(distilledPath), 'distilled profile patch should exist');

  const short = run([
    'propose',
    '--profile-id=cap_beta',
    '--intent=send_email',
    '--failure-reason=adapter_kind_unresolved'
  ], env);
  assert.strictEqual(short.status, 0, short.stderr || short.stdout);
  const shortPayload = parseJson(short.stdout);
  const shortCandidateId = String(shortPayload.candidate.candidate_id || '');
  assert.ok(shortCandidateId);
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  state.candidates[shortCandidateId].expires_at = '2000-01-01T00:00:00.000Z';
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');

  const gc = run(['gc'], env);
  assert.strictEqual(gc.status, 0, gc.stderr || gc.stdout);
  const gcPayload = parseJson(gc.stdout);
  assert.ok(Number(gcPayload.expired || 0) >= 1, 'gc should expire stale candidates');

  const status = run(['status'], env);
  assert.strictEqual(status.status, 0, status.stderr || status.stdout);
  const statusPayload = parseJson(status.stdout);
  assert.strictEqual(statusPayload.ok, true);
  assert.ok(Number(statusPayload.candidate_count || 0) >= 2);
  assert.ok(statusPayload.status_counts && typeof statusPayload.status_counts === 'object');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('sub_executor_synthesis.test.js: OK');
} catch (err) {
  console.error(`sub_executor_synthesis.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
