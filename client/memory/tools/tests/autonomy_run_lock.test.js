#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

function mkDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function run() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const tmpRoot = path.join(__dirname, 'temp_autonomy_run_lock');
  if (fs.existsSync(tmpRoot)) fs.rmSync(tmpRoot, { recursive: true, force: true });
  mkDir(tmpRoot);

  const lockPath = path.join(tmpRoot, 'run.lock');
  mkDir(path.dirname(lockPath));
  fs.writeFileSync(lockPath, JSON.stringify({
    ts: new Date().toISOString(),
    pid: 12345,
    mode: 'run',
    date: '2026-02-21'
  }, null, 2), 'utf8');

  const script = path.join(repoRoot, 'systems', 'autonomy', 'autonomy_controller.js');
  const env = {
    ...process.env,
    AUTONOMY_RUN_LOCK_PATH: lockPath,
    AUTONOMY_RUN_LOCK_STALE_MINUTES: '999',
    AUTONOMY_ENABLED: '1'
  };
  const r = spawnSync('node', [script, 'run', '2026-02-21'], { cwd: repoRoot, encoding: 'utf8', env });
  assert.strictEqual(r.status, 0, `autonomy run should not crash: ${r.stderr}`);
  const out = JSON.parse(String(r.stdout || '{}'));
  assert.strictEqual(out.result, 'stop_init_gate_run_lock');
  assert.strictEqual(out.lock_code, 'lock_held');

  console.log('autonomy_run_lock.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_run_lock.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
