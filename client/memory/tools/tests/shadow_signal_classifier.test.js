#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');

function run(args = []) {
  const out = spawnSync(process.execPath, [path.join(ROOT, 'systems/shadow/shadow_signal_classifier.js'), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: process.env
  });
  const payload = String(out.stdout || '').trim();
  return {
    status: out.status,
    payload: payload ? JSON.parse(payload) : {},
    stderr: String(out.stderr || '')
  };
}

function main() {
  const signal = JSON.stringify({
    id: 'sig_1',
    severity: 'warn',
    tags: ['infra', 'memory'],
    summary: 'infra timeout with memory pressure'
  });
  const res = run(['classify', `--signal-json=${signal}`]);
  assert.strictEqual(res.status, 0, res.stderr);
  assert.strictEqual(res.payload.ok, true);
  assert.ok(Array.isArray(res.payload.payload.routes));
  assert.ok(res.payload.payload.routes.length >= 1);
  assert.ok(Number(res.payload.payload.confidence || 0) > 0);
  console.log('shadow_signal_classifier.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`shadow_signal_classifier.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
