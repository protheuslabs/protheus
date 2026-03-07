#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'core', 'memory', 'compat_bridge.js');

function run(args) {
  const proc = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  let payload = null;
  try { payload = JSON.parse(String(proc.stdout || '').trim()); } catch {}
  return {
    status: Number.isFinite(proc.status) ? proc.status : 1,
    stdout: String(proc.stdout || ''),
    stderr: String(proc.stderr || ''),
    payload
  };
}

try {
  const out = run(['status']);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.ok === true, 'status should pass');
  assert.strictEqual(out.payload.type, 'core_memory_compat_status');
  assert.strictEqual(out.payload.alias_exists, true, 'alias root should exist');
  assert.strictEqual(out.payload.canonical_exists, true, 'canonical rust root should exist');
  assert.strictEqual(out.payload.cargo_toml_exists, true, 'canonical crate should expose Cargo.toml');
  assert.ok(Array.isArray(out.payload.map.crate_name_aliases), 'crate aliases should be listed');
  assert.ok(out.payload.map.crate_name_aliases.includes('protheus-memory-core'), 'canonical crate alias should include protheus-memory-core');
  console.log('core_memory_compat_bridge.test.js: OK');
} catch (err) {
  console.error(`core_memory_compat_bridge.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
