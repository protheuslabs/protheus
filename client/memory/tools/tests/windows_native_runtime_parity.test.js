#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'runtime', 'windows_native_runtime_parity.js');

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

function run(args, env) {
  const proc = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'windows-parity-'));
  const policyPath = path.join(tmp, 'config', 'windows_native_runtime_parity_policy.json');
  const latestPath = path.join(tmp, 'state', 'runtime', 'windows_native_runtime_parity', 'latest.json');
  const historyPath = path.join(tmp, 'state', 'runtime', 'windows_native_runtime_parity', 'history.jsonl');

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    required_capabilities: {
      tauri_shell: true,
      directml: true,
      onnx_runtime: true
    },
    fallback_runtime: 'cross_platform_runtime',
    rollback_command: 'node client/systems/runtime/windows_native_runtime_parity.js run --force-fallback=1',
    paths: {
      latest_path: latestPath,
      history_path: historyPath
    }
  });

  let out = run(['run', '--host-os=win32', '--host-arch=x64', '--tauri=1', '--directml=1', '--onnx=1', '--strict=1', `--policy=${policyPath}`], {
    WINDOWS_RUNTIME_PARITY_ROOT: tmp,
    WINDOWS_RUNTIME_PARITY_POLICY_PATH: policyPath
  });
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.strictEqual(out.payload.ok, true, 'windows parity should pass when all capabilities exist');
  assert.strictEqual(out.payload.selected_runtime, 'windows_native_runtime', 'native runtime should be selected');

  out = run(['run', '--host-os=win32', '--host-arch=x64', '--tauri=1', '--directml=0', '--onnx=1', '--strict=1', `--policy=${policyPath}`], {
    WINDOWS_RUNTIME_PARITY_ROOT: tmp,
    WINDOWS_RUNTIME_PARITY_POLICY_PATH: policyPath
  });
  assert.notStrictEqual(out.status, 0, 'strict run should fail when capability is missing');
  assert.strictEqual(out.payload.ok, false, 'parity should fail with missing directml');
  assert.strictEqual(out.payload.selected_runtime, 'cross_platform_runtime', 'fallback runtime should be selected');
  assert.ok(Array.isArray(out.payload.fallback_reason_codes) && out.payload.fallback_reason_codes.includes('directml_missing'), 'directml failure reason missing');

  out = run(['status', `--policy=${policyPath}`], {
    WINDOWS_RUNTIME_PARITY_ROOT: tmp,
    WINDOWS_RUNTIME_PARITY_POLICY_PATH: policyPath
  });
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.ok === true, 'status should load latest state');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('windows_native_runtime_parity.test.js: OK');
} catch (err) {
  console.error(`windows_native_runtime_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
