#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'dist_runtime_cutover.js');

function runCmd(args, env) {
  return spawnSync('node', [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...env
    }
  });
}

function parseJson(stdout) {
  return JSON.parse(String(stdout || '{}'));
}

function run() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dist-runtime-cutover-test-'));
  const statePath = path.join(tmp, 'runtime_mode.json');
  const baseEnv = {
    PROTHEUS_RUNTIME_MODE_STATE_PATH: statePath
  };

  let r = runCmd(['status'], baseEnv);
  assert.strictEqual(r.status, 0, `status should pass: ${r.stderr}`);
  let out = parseJson(r.stdout);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.state_mode, 'source');

  r = runCmd(['set-mode', '--mode=dist'], baseEnv);
  assert.strictEqual(r.status, 0, `set-mode dist should pass: ${r.stderr}`);
  out = parseJson(r.stdout);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.mode, 'dist');
  assert.ok(fs.existsSync(statePath), 'set-mode should write state file');

  r = runCmd(['status'], baseEnv);
  assert.strictEqual(r.status, 0, `status after set-mode should pass: ${r.stderr}`);
  out = parseJson(r.stdout);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.state_mode, 'dist');
  assert.strictEqual(out.effective_mode, 'dist');

  r = runCmd(['status'], {
    ...baseEnv,
    PROTHEUS_RUNTIME_MODE: 'source'
  });
  assert.strictEqual(r.status, 0, `status with env override should pass: ${r.stderr}`);
  out = parseJson(r.stdout);
  assert.strictEqual(out.effective_mode, 'source');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('dist_runtime_cutover.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`dist_runtime_cutover.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
