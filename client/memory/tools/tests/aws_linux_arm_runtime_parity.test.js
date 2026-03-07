#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'runtime', 'aws_linux_arm_runtime_parity.js');

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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-arm-parity-'));
  const policyPath = path.join(tmp, 'config', 'aws_linux_arm_runtime_parity_policy.json');
  const latestPath = path.join(tmp, 'state', 'runtime', 'aws_linux_arm_runtime_parity', 'latest.json');
  const historyPath = path.join(tmp, 'state', 'runtime', 'aws_linux_arm_runtime_parity', 'history.jsonl');

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    allowed_arches: ['arm64', 'aarch64'],
    allowed_distros: ['al2023', 'bottlerocket'],
    required_capabilities: {
      graviton: true,
      neuron: true,
      bottlerocket_profile: true
    },
    fallback_runtime: 'cross_platform_runtime',
    rollback_command: 'node client/systems/runtime/aws_linux_arm_runtime_parity.js run --force-fallback=1',
    paths: {
      latest_path: latestPath,
      history_path: historyPath
    }
  });

  let out = run(['run', '--host-os=linux', '--host-arch=arm64', '--host-distro=al2023', '--graviton=1', '--neuron=1', '--bottlerocket-profile=1', '--strict=1', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.strictEqual(out.payload.ok, true, 'parity should pass for AL2023 arm64 with required capabilities');
  assert.strictEqual(out.payload.selected_runtime, 'aws_linux_arm_runtime', 'runtime should be aws_linux_arm_runtime');

  out = run(['run', '--host-os=linux', '--host-arch=x64', '--host-distro=al2023', '--graviton=1', '--neuron=1', '--bottlerocket-profile=1', '--strict=1', `--policy=${policyPath}`]);
  assert.notStrictEqual(out.status, 0, 'strict run should fail on unsupported arch');
  assert.strictEqual(out.payload.ok, false, 'parity should fail on unsupported arch');
  assert.strictEqual(out.payload.selected_runtime, 'cross_platform_runtime', 'fallback runtime expected');
  assert.ok(Array.isArray(out.payload.fallback_reason_codes) && out.payload.fallback_reason_codes.includes('arch_not_supported'), 'arch_not_supported reason expected');

  out = run(['status', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.latest, 'status should report latest payload');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('aws_linux_arm_runtime_parity.test.js: OK');
} catch (err) {
  console.error(`aws_linux_arm_runtime_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
