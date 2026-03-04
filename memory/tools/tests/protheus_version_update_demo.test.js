#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const PROTHEUSCTL = path.join(ROOT, 'systems', 'ops', 'protheusctl.js');

function parseJson(raw) {
  const txt = String(raw || '').trim();
  if (!txt) return null;
  try {
    return JSON.parse(txt);
  } catch {}
  const lines = txt.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i]);
    } catch {}
  }
  return null;
}

function run(args, env = {}) {
  const out = spawnSync(process.execPath, [PROTHEUSCTL, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      PROTHEUS_RUNTIME_MODE: 'source',
      PROTHEUS_CTL_SECURITY_GATE_DISABLED: '1',
      PROTHEUS_CLI_SUGGESTIONS: '0',
      PROTHEUS_SKIP_SETUP: '1',
      PROTHEUS_UPDATE_CHECKER_DISABLED: '1',
      ...env
    }
  });
  return {
    status: Number.isFinite(out.status) ? Number(out.status) : 1,
    stdout: String(out.stdout || ''),
    stderr: String(out.stderr || ''),
    payload: parseJson(out.stdout)
  };
}

try {
  let out = run(['--version']);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.stdout.includes('protheus '), 'global --version should print version line');

  out = run(['version', '--json=1']);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.type === 'protheus_version', 'version should emit structured payload');
  assert.ok(typeof out.payload.current_version === 'string', 'version payload should include current version');

  out = run(['update', '--json=1']);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.type === 'protheus_update', 'update should emit structured payload');
  assert.ok(Object.prototype.hasOwnProperty.call(out.payload, 'update_available'), 'update payload should include update_available');

  out = run(['demo', '--json=1']);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.type === 'protheus_demo', 'demo should emit structured payload');
  assert.ok(Array.isArray(out.payload.steps) && out.payload.steps.length >= 3, 'demo should include steps');

  out = run(['research', '--example']);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.stdout.includes('protheus research'), '--example should route to examples output');

  out = run(['list', '--json']);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.type === 'protheus_command_manifest', 'global --json should work for list command');

  console.log('protheus_version_update_demo.test.js: OK');
} catch (err) {
  console.error(`protheus_version_update_demo.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
