#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const PROFILE = path.join(ROOT, 'packages', 'protheus-core', 'core_profile_contract.js');
const STARTER = path.join(ROOT, 'packages', 'protheus-core', 'starter.js');

function parseJson(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

function run(script, args) {
  const proc = spawnSync(process.execPath, [script, ...args], {
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
  let out = run(PROFILE, ['configure', '--owner=jay', '--mode=lite']);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  out = run(PROFILE, ['bootstrap', '--owner=jay', '--mode=lite']);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  out = run(STARTER, []);
  assert.ok(out.payload && out.payload.ok === true, 'starter output should be structured');
  console.log('protheus_core_package.test.js: OK');
} catch (err) {
  console.error(`protheus_core_package.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
