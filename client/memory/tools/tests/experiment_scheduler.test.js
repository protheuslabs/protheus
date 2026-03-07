#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'science', 'experiment_scheduler.js');

function write(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function writeJson(filePath, payload) {
  write(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

function run(args, env) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8'
  });
}

function parseJson(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const lines = text.split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-scheduler-'));
  const policyPath = path.join(tmp, 'config', 'experiment_scheduler_policy.json');
  const hypothesesPath = path.join(tmp, 'state', 'science', 'hypothesis_forge', 'ranked.json');
  const queuePath = path.join(tmp, 'state', 'science', 'experiment_scheduler', 'queue.jsonl');
  const latestPath = path.join(tmp, 'state', 'science', 'experiment_scheduler', 'latest.json');
  const historyPath = path.join(tmp, 'state', 'science', 'experiment_scheduler', 'history.jsonl');
  const noOpPath = path.join(tmp, 'state', 'science', 'experiment_scheduler', 'noop_state.json');
  const consentPath = path.join(tmp, 'state', 'science', 'experiment_scheduler', 'consent.json');

  writeJson(hypothesesPath, {
    ranked: [
      { id: 'h1', text: 'High VOI low risk', score: 0.9, voi: 0.9, risk: 0.2, rank_receipt_id: 'r1' },
      { id: 'h2', text: 'High risk candidate', score: 0.8, voi: 0.8, risk: 0.9, rank_receipt_id: 'r2' }
    ]
  });

  writeJson(consentPath, {
    h1: { id: 'consent-h1', approved: true, expires_at: '2030-01-01T00:00:00.000Z' }
  });

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    no_op_default: false,
    max_risk: 0.6,
    consent_timeout_minutes: 60,
    schedule_interval_minutes: 30,
    default_deny_without_consent: true,
    sandbox_required: true,
    paths: {
      hypotheses_path: hypothesesPath,
      queue_path: queuePath,
      latest_path: latestPath,
      history_path: historyPath,
      no_op_state_path: noOpPath
    }
  });

  const env = {
    EXPERIMENT_SCHEDULER_ROOT: tmp,
    EXPERIMENT_SCHEDULER_POLICY_PATH: policyPath
  };

  let out = run([
    'schedule',
    '--apply=1',
    '--consent-map-file', consentPath,
    '--now-iso', '2026-03-02T10:00:00.000Z'
  ], env);
  assert.strictEqual(out.status, 0, out.stderr || 'schedule should pass');
  let payload = parseJson(out.stdout);
  assert.ok(payload && payload.ok === true, 'schedule payload should be ok');
  assert.strictEqual(Number(payload.scheduled_count || 0), 1, 'one hypothesis should be scheduled');
  assert.strictEqual(Number(payload.denied_count || 0), 1, 'one hypothesis should be denied due to risk');
  const queueLines = fs.existsSync(queuePath) ? fs.readFileSync(queuePath, 'utf8').trim().split('\n').filter(Boolean) : [];
  assert.strictEqual(queueLines.length, 1, 'queue should contain one scheduled item');

  out = run(['rollback', '--reason=testing_noop'], env);
  assert.strictEqual(out.status, 0, out.stderr || 'rollback should pass');
  payload = parseJson(out.stdout);
  assert.ok(payload && payload.ok === true, 'rollback payload should be ok');

  out = run([
    'schedule',
    '--apply=1',
    '--consent-map-file', consentPath,
    '--now-iso', '2026-03-02T11:00:00.000Z'
  ], env);
  assert.strictEqual(out.status, 0, out.stderr || 'schedule in no-op mode should pass');
  payload = parseJson(out.stdout);
  assert.ok(payload && payload.no_op_mode === true, 'no-op mode should be active after rollback');

  out = run(['status'], env);
  assert.strictEqual(out.status, 0, out.stderr || 'status should pass');
  payload = parseJson(out.stdout);
  assert.ok(payload && payload.ok === true, 'status payload should be ok');

  console.log('experiment_scheduler.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`experiment_scheduler.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
