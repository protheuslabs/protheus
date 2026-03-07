#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'protheus_core_rust_binding_plane.js');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function parseJson(stdout) {
  const txt = String(stdout || '').trim();
  if (!txt) return null;
  try { return JSON.parse(txt); } catch {}
  const lines = txt.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function run(args) {
  const proc = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8' });
  return {
    status: Number.isFinite(proc.status) ? Number(proc.status) : 1,
    stdout: String(proc.stdout || ''),
    stderr: String(proc.stderr || ''),
    payload: parseJson(proc.stdout)
  };
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'core-rust-binding-'));
  const policyPath = path.join(tmp, 'config', 'protheus_core_rust_binding_plane_policy.json');
  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    strict_default: true,
    event_stream: { enabled: false, publish: false, stream: 'ops.protheus_core_rust_binding_plane' },
    core_module_path: path.join(ROOT, 'packages', 'protheus-core', 'index.js'),
    rust_component_shim_script: path.join(ROOT, 'systems', 'rust', 'control_plane_component_shim.js'),
    napi_surface_script: path.join(ROOT, 'systems', 'memory', 'napi_build_surface_compat.js'),
    fallback_to_ts_enabled: true,
    required_exports: ['coreStatus', 'coldStartContract'],
    components: ['guard', 'spine_router'],
    paths: {
      memory_dir: path.join(tmp, 'memory', 'ops', 'protheus_core_rust_binding_plane'),
      adaptive_index_path: path.join(tmp, 'adaptive', 'ops', 'protheus_core_rust_binding_plane', 'index.json'),
      events_path: path.join(tmp, 'state', 'ops', 'protheus_core_rust_binding_plane', 'events.jsonl'),
      latest_path: path.join(tmp, 'state', 'ops', 'protheus_core_rust_binding_plane', 'latest.json'),
      receipts_path: path.join(tmp, 'state', 'ops', 'protheus_core_rust_binding_plane', 'receipts.jsonl'),
      binding_state_path: path.join(tmp, 'state', 'ops', 'protheus_core_rust_binding_plane', 'state.json')
    }
  });

  const out = run(['verify', '--owner=jay', '--mock=1', '--strict=1', '--apply=1', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.event === 'protheus_core_rust_binding_plane_verify', 'verify should emit binding receipt');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('protheus_core_rust_binding_plane.test.js: OK');
} catch (err) {
  console.error(`protheus_core_rust_binding_plane.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
