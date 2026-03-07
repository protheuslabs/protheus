#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'adaptive', 'realtime_adaptation_loop.js');

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function run(args, env = {}) {
  const proc = spawnSync('node', [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env }
  });
  return {
    status: Number.isFinite(Number(proc.status)) ? Number(proc.status) : 1,
    stdout: String(proc.stdout || ''),
    stderr: String(proc.stderr || '')
  };
}

function parseJson(stdout) {
  const txt = String(stdout || '').trim();
  return txt ? JSON.parse(txt) : null;
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'realtime-adapt-loop-'));
  writeJson(path.join(tmp, 'AGENTS.md'), { ok: true });
  writeJson(path.join(tmp, 'package.json'), { name: 'tmp' });

  const policyPath = path.join(tmp, 'client', 'config', 'realtime_adaptation_loop_policy.json');
  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    min_cycle_interval_ms: 60000,
    resource_ceilings: {
      max_cpu_ms: 200,
      max_tokens: 400,
      max_memory_mb: 256
    },
    paths: {
      state_path: path.join(tmp, 'state', 'adaptive', 'realtime_adaptation_loop', 'state.json'),
      latest_path: path.join(tmp, 'state', 'adaptive', 'realtime_adaptation_loop', 'latest.json'),
      receipts_path: path.join(tmp, 'state', 'adaptive', 'realtime_adaptation_loop', 'receipts.jsonl')
    }
  });

  const envBase = {
    OPENCLAW_WORKSPACE: tmp,
    REALTIME_ADAPTATION_LOOP_POLICY_PATH: policyPath
  };

  let out = run([
    'cycle',
    '--trigger=interaction',
    '--interaction-id=evt_1',
    '--cpu-ms=110',
    '--tokens=120',
    '--memory-mb=128',
    '--apply=1'
  ], {
    ...envBase,
    PROTHEUS_NOW_ISO: '2026-03-07T08:00:00.000Z'
  });
  assert.strictEqual(out.status, 0, out.stderr);
  let payload = parseJson(out.stdout);
  assert.ok(payload && payload.ok === true, 'first cycle should pass');
  assert.strictEqual(Number(payload.cycle_count_after), 1);

  out = run([
    'cycle',
    '--trigger=heartbeat',
    '--heartbeat-id=hb_early',
    '--cpu-ms=80',
    '--tokens=100',
    '--memory-mb=128',
    '--apply=1'
  ], {
    ...envBase,
    PROTHEUS_NOW_ISO: '2026-03-07T08:00:20.000Z'
  });
  assert.strictEqual(out.status, 0, out.stderr);
  payload = parseJson(out.stdout);
  assert.ok(payload && payload.ok === false, 'cadence-throttled cycle should block');
  assert.ok(Array.isArray(payload.blocked_reasons) && payload.blocked_reasons.includes('cadence_throttle'));

  out = run([
    'cycle',
    '--trigger=heartbeat',
    '--heartbeat-id=hb_high_cpu',
    '--cpu-ms=450',
    '--tokens=120',
    '--memory-mb=128',
    '--apply=1'
  ], {
    ...envBase,
    PROTHEUS_NOW_ISO: '2026-03-07T08:02:00.000Z'
  });
  assert.strictEqual(out.status, 0, out.stderr);
  payload = parseJson(out.stdout);
  assert.ok(payload && payload.ok === false, 'ceiling breach should block');
  assert.ok(Array.isArray(payload.blocked_reasons) && payload.blocked_reasons.includes('cpu_ceiling_exceeded'));

  out = run([
    'cycle',
    '--trigger=heartbeat',
    '--heartbeat-id=hb_1',
    '--cpu-ms=90',
    '--tokens=180',
    '--memory-mb=128',
    '--apply=1'
  ], {
    ...envBase,
    PROTHEUS_NOW_ISO: '2026-03-07T08:03:30.000Z'
  });
  assert.strictEqual(out.status, 0, out.stderr);
  payload = parseJson(out.stdout);
  assert.ok(payload && payload.ok === true, 'heartbeat cycle should pass after interval');
  assert.strictEqual(String(payload.trigger), 'heartbeat');
  assert.strictEqual(Number(payload.cycle_count_after), 2);

  out = run(['status'], envBase);
  assert.strictEqual(out.status, 0, out.stderr);
  payload = parseJson(out.stdout);
  assert.ok(payload && payload.ok === true, 'status should be ok');
  assert.strictEqual(Number(payload.state.cycle_count), 2, 'state should persist applied cycles');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('realtime_adaptation_loop.test.js: OK');
} catch (err) {
  console.error(`realtime_adaptation_loop.test.js: FAIL: ${err && err.message ? err.message : err}`);
  process.exit(1);
}
