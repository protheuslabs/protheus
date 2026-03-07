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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'realtime-adapt-low-power-'));
  writeJson(path.join(tmp, 'AGENTS.md'), { ok: true });
  writeJson(path.join(tmp, 'package.json'), { name: 'tmp' });

  const policyPath = path.join(tmp, 'client', 'config', 'realtime_adaptation_loop_policy.json');
  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    min_cycle_interval_ms: 10000,
    resource_ceilings: {
      max_cpu_ms: 200,
      max_tokens: 500,
      max_memory_mb: 320
    },
    profiles: {
      default: {
        cadence_multiplier: 1,
        cpu_multiplier: 1,
        tokens_multiplier: 1,
        memory_multiplier: 1
      },
      low_power: {
        cadence_multiplier: 2,
        cpu_multiplier: 0.5,
        tokens_multiplier: 0.6,
        memory_multiplier: 0.7
      }
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

  let out = run(['cycle', '--profile=default', '--cpu-ms=110', '--tokens=140', '--memory-mb=180'], {
    ...envBase,
    PROTHEUS_NOW_ISO: '2026-03-07T09:00:00.000Z'
  });
  assert.strictEqual(out.status, 0, out.stderr);
  let payload = parseJson(out.stdout);
  assert.ok(payload && payload.ok === true, 'default profile should accept baseline load');

  out = run(['cycle', '--profile=low_power', '--cpu-ms=110', '--tokens=140', '--memory-mb=180'], {
    ...envBase,
    PROTHEUS_NOW_ISO: '2026-03-07T09:00:25.000Z'
  });
  assert.strictEqual(out.status, 0, out.stderr);
  payload = parseJson(out.stdout);
  assert.ok(payload && payload.ok === false, 'low-power profile should reject CPU above reduced ceiling');
  assert.ok(Array.isArray(payload.blocked_reasons) && payload.blocked_reasons.includes('cpu_ceiling_exceeded'));

  out = run(['cycle', '--profile=low_power', '--cpu-ms=90', '--tokens=120', '--memory-mb=180', '--trigger=heartbeat'], {
    ...envBase,
    PROTHEUS_NOW_ISO: '2026-03-07T09:00:45.000Z'
  });
  assert.strictEqual(out.status, 0, out.stderr);
  payload = parseJson(out.stdout);
  assert.ok(payload && payload.ok === true, 'low-power profile should pass under reduced budget');
  assert.strictEqual(String(payload.profile), 'low_power');
  assert.ok(payload.hardware_profile && payload.hardware_profile.arch, 'hardware metadata should be present');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('realtime_adaptation_low_power_profile.test.js: OK');
} catch (err) {
  console.error(`realtime_adaptation_low_power_profile.test.js: FAIL: ${err && err.message ? err.message : err}`);
  process.exit(1);
}
