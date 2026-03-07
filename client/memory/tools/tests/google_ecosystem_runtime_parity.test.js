#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'runtime', 'google_ecosystem_runtime_parity.js');

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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'google-parity-'));
  const policyPath = path.join(tmp, 'config', 'google_ecosystem_runtime_parity_policy.json');
  const latestPath = path.join(tmp, 'state', 'runtime', 'google_ecosystem_runtime_parity', 'latest.json');
  const historyPath = path.join(tmp, 'state', 'runtime', 'google_ecosystem_runtime_parity', 'history.jsonl');

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    required_surfaces: ['android', 'chromeos', 'fuchsia'],
    privileged_service_requirements: {
      android: true,
      chromeos: true,
      fuchsia: false
    },
    min_android_api_level: 16,
    fallback_runtime: 'baseline_mobile_runtime',
    rollback_command: 'node client/systems/runtime/google_ecosystem_runtime_parity.js run --force-fallback=1',
    paths: {
      latest_path: latestPath,
      history_path: historyPath
    }
  });

  let out = run(['run', '--android=1', '--chromeos=1', '--fuchsia=1', '--android-privileged=1', '--chromeos-privileged=1', '--fuchsia-privileged=0', '--android-api=16', '--strict=1', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.strictEqual(out.payload.ok, true, 'parity should pass when all required surfaces are available');
  assert.strictEqual(out.payload.selected_runtime, 'google_ecosystem_runtime', 'runtime should be google_ecosystem_runtime');

  out = run(['run', '--android=1', '--chromeos=1', '--fuchsia=1', '--android-privileged=1', '--chromeos-privileged=0', '--android-api=16', '--strict=1', `--policy=${policyPath}`]);
  assert.notStrictEqual(out.status, 0, 'strict run should fail when required privileged service is missing');
  assert.strictEqual(out.payload.ok, false, 'parity should fail when chromeos privileged service is missing');
  assert.strictEqual(out.payload.selected_runtime, 'baseline_mobile_runtime', 'fallback runtime should be selected');
  assert.ok(Array.isArray(out.payload.fallback_reason_codes) && out.payload.fallback_reason_codes.includes('chromeos_privileged_service_missing'), 'expected privileged-service failure');

  out = run(['status', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.latest, 'status should return latest snapshot');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('google_ecosystem_runtime_parity.test.js: OK');
} catch (err) {
  console.error(`google_ecosystem_runtime_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
