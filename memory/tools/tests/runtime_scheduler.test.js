#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'primitives', 'runtime_scheduler.js');

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
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

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-scheduler-'));
  const policyPath = path.join(tmp, 'policy.json');
  const statePath = path.join(tmp, 'state', 'scheduler', 'latest.json');
  const receiptsPath = path.join(tmp, 'state', 'scheduler', 'receipts.jsonl');
  const canonicalDir = path.join(tmp, 'state', 'runtime', 'canonical_events');
  writeJson(policyPath, {
    schema_id: 'runtime_scheduler_policy',
    schema_version: '1.0',
    enabled: true,
    default_mode: 'operational',
    modes: ['operational', 'dream', 'inversion'],
    allowed_transitions: {
      operational: ['operational', 'dream', 'inversion'],
      dream: ['dream', 'operational'],
      inversion: ['inversion', 'operational']
    },
    state_path: statePath,
    receipts_path: receiptsPath
  });

  const env = {
    RUNTIME_SCHEDULER_POLICY_PATH: policyPath,
    CANONICAL_EVENT_LOG_DIR: canonicalDir
  };

  const status1 = run(['status'], env);
  assert.strictEqual(status1.status, 0, status1.stderr || status1.stdout);
  const status1Payload = parseJson(status1.stdout);
  assert.strictEqual(status1Payload.mode, 'operational');

  const toDream = run(['switch', '--mode=dream', '--reason=test', '--apply=1'], env);
  assert.strictEqual(toDream.status, 0, toDream.stderr || toDream.stdout);
  const toDreamPayload = parseJson(toDream.stdout);
  assert.strictEqual(toDreamPayload.ok, true);
  assert.strictEqual(toDreamPayload.to_mode, 'dream');

  const illegal = run(['switch', '--mode=inversion', '--reason=invalid', '--apply=1'], env);
  assert.notStrictEqual(illegal.status, 0, 'dream->inversion should be blocked by transition policy');
  const illegalPayload = parseJson(illegal.stdout);
  assert.strictEqual(illegalPayload.error, 'transition_not_allowed');

  const back = run(['switch', '--mode=operational', '--reason=back', '--apply=1'], env);
  assert.strictEqual(back.status, 0, back.stderr || back.stdout);

  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.strictEqual(state.mode, 'operational');
  assert.ok(fs.existsSync(receiptsPath), 'scheduler receipts should exist');

  const day = new Date().toISOString().slice(0, 10);
  const canonicalLog = path.join(canonicalDir, `${day}.jsonl`);
  assert.ok(fs.existsSync(canonicalLog), 'scheduler should emit canonical events');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('runtime_scheduler.test.js: OK');
} catch (err) {
  console.error(`runtime_scheduler.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
