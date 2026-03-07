#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'rust_authoritative_microkernel_acceleration.js');

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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rust-accel-'));
  const workspaceRoot = path.join(tmp, 'workspace');
  const policyPath = path.join(tmp, 'config', 'rust_authoritative_microkernel_acceleration_policy.json');

  writeText(path.join(workspaceRoot, 'systems', 'a.ts'), 'export function alpha() { return 1; }\n');
  writeText(path.join(workspaceRoot, 'systems', 'a.js'), 'module.exports = { beta: 1 };\n');
  writeText(path.join(workspaceRoot, 'systems', 'a.rs'), 'pub fn gamma() {}\n');

  const okScript = path.join(tmp, 'ok.js');
  writeText(okScript, 'console.log(JSON.stringify({ ok: true, type: "ok" }));\n');

  writeJson(policyPath, {
    enabled: true,
    strict_default: true,
    targets: {
      rust_share_min_pct: 0,
      rust_share_max_pct: 100,
      enforce_target_during_cutover: true
    },
    scan: {
      include_extensions: ['.rs', '.ts', '.js'],
      ignore_roots: []
    },
    commands: {
      rust_spine_parity: ['node', okScript],
      rust_spine_benchmark: ['node', okScript],
      rust_spine_cutover: ['node', okScript],
      wasi2_gate: ['node', okScript],
      sandbox_coprocessor: ['node', okScript]
    },
    paths: {
      latest_path: path.join(tmp, 'state', 'latest.json'),
      receipts_path: path.join(tmp, 'state', 'receipts.jsonl'),
      language_report_path: path.join(tmp, 'state', 'language_report.json')
    }
  });

  let res = run(workspaceRoot, ['run', '--strict=1', '--apply=1', `--policy=${policyPath}`]);
  assert.strictEqual(res.status, 0, `run should pass: ${res.stderr}`);
  assert.ok(res.payload && res.payload.type === 'rust_authoritative_microkernel_acceleration');
  assert.ok(res.payload && res.payload.pass_required_checks === true, 'required checks should pass');

  const langReport = JSON.parse(fs.readFileSync(path.join(tmp, 'state', 'language_report.json'), 'utf8'));
  assert.ok(Number(langReport.rust_share_pct || 0) > 0, 'rust share should be non-zero');

  res = run(workspaceRoot, ['status', `--policy=${policyPath}`]);
  assert.strictEqual(res.status, 0, `status should pass: ${res.stderr}`);
  assert.ok(res.payload && res.payload.type === 'rust_authoritative_microkernel_acceleration_status');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('rust_authoritative_microkernel_acceleration.test.js: OK');
} catch (err) {
  console.error(`rust_authoritative_microkernel_acceleration.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
