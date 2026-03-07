#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'type_derived_lane_docs_autogen.js');

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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'type-docs-autogen-'));
  const workspaceRoot = path.join(tmp, 'workspace');
  const policyPath = path.join(tmp, 'config', 'type_derived_lane_docs_autogen_policy.json');

  writeText(path.join(workspaceRoot, 'systems', 'sample.ts'), 'export function alpha() { return 1; }\nexport type Beta = { ok: boolean };\n');
  writeText(path.join(workspaceRoot, 'systems', 'sample.rs'), 'pub fn gamma() {}\npub struct Delta {}\n');

  writeJson(policyPath, {
    enabled: true,
    strict_default: true,
    ts_roots: [path.join(workspaceRoot, 'systems')],
    rust_roots: [path.join(workspaceRoot, 'systems')],
    docs: {
      ts_reference_path: path.join(workspaceRoot, 'docs', 'generated', 'TS.md'),
      rust_reference_path: path.join(workspaceRoot, 'docs', 'generated', 'RUST.md')
    },
    paths: {
      latest_path: path.join(tmp, 'state', 'latest.json'),
      receipts_path: path.join(tmp, 'state', 'receipts.jsonl'),
      snapshots_root: path.join(tmp, 'state', 'snapshots')
    }
  });

  let res = run(workspaceRoot, ['generate', '--apply=1', '--strict=1', `--policy=${policyPath}`]);
  assert.strictEqual(res.status, 0, `generate should pass: ${res.stderr}`);
  assert.ok(res.payload && res.payload.type === 'type_derived_lane_docs_autogen_generate');

  const tsDoc = fs.readFileSync(path.join(workspaceRoot, 'docs', 'generated', 'TS.md'), 'utf8');
  const rustDoc = fs.readFileSync(path.join(workspaceRoot, 'docs', 'generated', 'RUST.md'), 'utf8');
  assert.ok(tsDoc.includes('alpha'), 'TS doc should include exported function');
  assert.ok(rustDoc.includes('gamma'), 'Rust doc should include exported function');

  res = run(workspaceRoot, ['verify', '--strict=1', `--policy=${policyPath}`]);
  assert.strictEqual(res.status, 0, `verify should pass after generate: ${res.stderr}`);
  assert.ok(res.payload && res.payload.pass === true, 'verify should pass');

  writeText(path.join(workspaceRoot, 'systems', 'sample.ts'), 'export function alpha() { return 2; }\nexport function omega() { return 3; }\n');
  res = run(workspaceRoot, ['verify', '--strict=1', `--policy=${policyPath}`]);
  assert.strictEqual(res.status, 1, 'verify should fail when docs are stale');

  res = run(workspaceRoot, ['generate', '--apply=1', '--strict=1', `--policy=${policyPath}`]);
  assert.strictEqual(res.status, 0, 'regenerate should pass');

  res = run(workspaceRoot, ['status', `--policy=${policyPath}`]);
  assert.strictEqual(res.status, 0, `status should pass: ${res.stderr}`);
  assert.ok(res.payload && res.payload.type === 'type_derived_lane_docs_autogen_status');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('type_derived_lane_docs_autogen.test.js: OK');
} catch (err) {
  console.error(`type_derived_lane_docs_autogen.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
