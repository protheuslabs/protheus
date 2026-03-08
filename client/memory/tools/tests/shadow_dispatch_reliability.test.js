#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');

function run(args = []) {
  const out = spawnSync(process.execPath, [path.join(ROOT, 'systems/shadow/shadow_dispatch_reliability.js'), ...args], {
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
  const enqueue = run(['enqueue', '--shadow=ops', '--message=runtime degraded', '--idempotency-key=test_key', '--apply=1']);
  assert.strictEqual(enqueue.status, 0, enqueue.stderr);
  assert.strictEqual(enqueue.payload.ok, true);
  const id = enqueue.payload.payload.dispatch_id || enqueue.payload.payload.reused_dispatch_id;

  const cycle = run(['dispatch', '--limit=5', '--apply=1']);
  assert.strictEqual(cycle.status, 0, cycle.stderr);
  assert.strictEqual(cycle.payload.ok, true);
  assert.ok(Array.isArray(cycle.payload.payload.processed));

  const targetId = id || (cycle.payload.payload.processed[0] && cycle.payload.payload.processed[0].dispatch_id);
  assert.ok(targetId, 'dispatch id missing');

  const ack = run(['ack', `--dispatch-id=${targetId}`, '--apply=1']);
  assert.strictEqual(ack.status, 0, ack.stderr);
  assert.strictEqual(ack.payload.ok, true);
  assert.strictEqual(ack.payload.payload.status, 'acked');

  console.log('shadow_dispatch_reliability.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`shadow_dispatch_reliability.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
