#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'rust_workspace_quality_gate.js');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeText(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, String(value), 'utf8');
}

function run(workspaceRoot, args) {
  const res = spawnSync('node', [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      OPENCLAW_WORKSPACE: workspaceRoot
    }
  });
  let payload = null;
  try { payload = JSON.parse(String(res.stdout || '').trim()); } catch {}
  return {
    status: typeof res.status === 'number' ? res.status : 1,
    payload,
    stderr: String(res.stderr || '')
  };
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rust-workspace-gate-'));
  const workspaceRoot = path.join(tmp, 'workspace');
  const policyPath = path.join(tmp, 'config', 'rust_workspace_quality_gate_policy.json');

  writeText(path.join(workspaceRoot, 'Cargo.toml'), '[workspace]\nresolver = "2"\n');
  writeText(path.join(workspaceRoot, 'rust-toolchain.toml'), '[toolchain]\nchannel = "stable"\n');
  writeText(path.join(workspaceRoot, 'docs', 'generated', 'TS_LANE_TYPE_REFERENCE.md'), '# TS\n');
  writeText(path.join(workspaceRoot, 'docs', 'generated', 'RUST_LANE_TYPE_REFERENCE.md'), '# Rust\n');

  writeJson(policyPath, {
    enabled: true,
    strict_default: true,
    cargo_bin: process.execPath,
    checks: {
      enforce_workspace_manifest: true,
      enforce_toolchain_manifest: true,
      enforce_docs_generated: true,
      enforce_cargo_metadata: true,
      enforce_cargo_fmt: false,
      enforce_cargo_clippy: false,
      enforce_cargo_test: false
    },
    commands: {
      metadata: ['-e', 'process.exit(0)'],
      fmt: ['-e', 'process.exit(0)'],
      clippy: ['-e', 'process.exit(0)'],
      test: ['-e', 'process.exit(0)']
    },
    docs_required: [
      path.join(workspaceRoot, 'docs', 'generated', 'TS_LANE_TYPE_REFERENCE.md'),
      path.join(workspaceRoot, 'docs', 'generated', 'RUST_LANE_TYPE_REFERENCE.md')
    ],
    paths: {
      latest_path: path.join(tmp, 'state', 'latest.json'),
      receipts_path: path.join(tmp, 'state', 'receipts.jsonl')
    }
  });

  let res = run(workspaceRoot, ['run', '--strict=1', '--apply=1', `--policy=${policyPath}`]);
  assert.strictEqual(res.status, 0, `run should pass: ${res.stderr}`);
  assert.ok(res.payload && res.payload.type === 'rust_workspace_quality_gate');
  assert.ok(res.payload && res.payload.pass === true, 'gate should pass');

  res = run(workspaceRoot, ['status', `--policy=${policyPath}`]);
  assert.strictEqual(res.status, 0, `status should pass: ${res.stderr}`);
  assert.ok(res.payload && res.payload.type === 'rust_workspace_quality_gate_status');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('rust_workspace_quality_gate.test.js: OK');
} catch (err) {
  console.error(`rust_workspace_quality_gate.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
