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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'realtime-adapt-continuity-'));
  writeJson(path.join(tmp, 'AGENTS.md'), { ok: true });
  writeJson(path.join(tmp, 'package.json'), { name: 'tmp' });

  const statePath = path.join(tmp, 'state', 'adaptive', 'realtime_adaptation_loop', 'state.json');
  const policyPath = path.join(tmp, 'client', 'config', 'realtime_adaptation_loop_policy.json');
  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    min_cycle_interval_ms: 1000,
    resource_ceilings: {
      max_cpu_ms: 250,
      max_tokens: 600,
      max_memory_mb: 400
    },
    paths: {
      state_path: statePath,
      latest_path: path.join(tmp, 'state', 'adaptive', 'realtime_adaptation_loop', 'latest.json'),
      receipts_path: path.join(tmp, 'state', 'adaptive', 'realtime_adaptation_loop', 'receipts.jsonl')
    }
  });

  const envBase = {
    OPENCLAW_WORKSPACE: tmp,
    REALTIME_ADAPTATION_LOOP_POLICY_PATH: policyPath
  };

  let out = run(['cycle', '--trigger=interaction', '--cpu-ms=80', '--tokens=90', '--memory-mb=120', '--apply=1'], {
    ...envBase,
    PROTHEUS_NOW_ISO: '2026-03-07T10:00:00.000Z'
  });
  assert.strictEqual(out.status, 0, out.stderr);
  let payload = parseJson(out.stdout);
  assert.ok(payload && payload.ok === true, 'initial cycle should pass');

  out = run(['verify-continuity'], envBase);
  assert.strictEqual(out.status, 0, out.stderr);
  payload = parseJson(out.stdout);
  assert.ok(payload && payload.ok === true, 'continuity should be valid before tamper');

  const tampered = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  tampered.cycle_count = Number(tampered.cycle_count || 0) + 4;
  fs.writeFileSync(statePath, `${JSON.stringify(tampered, null, 2)}\n`, 'utf8');

  out = run(['verify-continuity'], envBase);
  assert.notStrictEqual(out.status, 0, 'continuity verification should fail after tamper');
  payload = parseJson(out.stdout);
  assert.ok(payload && payload.ok === false, 'continuity payload should fail after tamper');

  out = run(['cycle', '--trigger=heartbeat', '--cpu-ms=80', '--tokens=90', '--memory-mb=120', '--apply=1'], {
    ...envBase,
    PROTHEUS_NOW_ISO: '2026-03-07T10:00:02.000Z'
  });
  assert.strictEqual(out.status, 0, out.stderr);
  payload = parseJson(out.stdout);
  assert.ok(payload && payload.ok === false, 'cycle should fail-closed on continuity violation');
  assert.ok(Array.isArray(payload.blocked_reasons) && payload.blocked_reasons.includes('continuity_integrity_violation'));

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('realtime_adaptation_continuity.test.js: OK');
} catch (err) {
  console.error(`realtime_adaptation_continuity.test.js: FAIL: ${err && err.message ? err.message : err}`);
  process.exit(1);
}
