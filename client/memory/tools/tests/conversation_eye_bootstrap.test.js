#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const CLIENT_ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(CLIENT_ROOT, 'systems', 'sensory', 'conversation_eye_bootstrap.js');

function run(args) {
  const proc = spawnSync('node', [SCRIPT, ...args], {
    cwd: CLIENT_ROOT,
    encoding: 'utf8',
    env: { ...process.env }
  });
  return {
    status: Number.isFinite(Number(proc.status)) ? Number(proc.status) : 1,
    stdout: String(proc.stdout || '').trim(),
    stderr: String(proc.stderr || '').trim()
  };
}

function parseJson(raw) {
  const text = String(raw || '').trim();
  return text ? JSON.parse(text) : null;
}

try {
  const ensureOut = run(['ensure', '--apply=1']);
  assert.strictEqual(ensureOut.status, 0, ensureOut.stderr);
  const ensurePayload = parseJson(ensureOut.stdout);
  assert.ok(ensurePayload && ensurePayload.ok === true, 'ensure should succeed');
  assert.strictEqual(String(ensurePayload.eye_id || ''), 'conversation_eye');

  const statusOut = run(['status']);
  assert.strictEqual(statusOut.status, 0, statusOut.stderr);
  const statusPayload = parseJson(statusOut.stdout);
  assert.ok(statusPayload && statusPayload.ok === true, 'status should succeed');
  assert.strictEqual(statusPayload.installed, true, 'conversation eye should be installed');
  assert.ok(statusPayload.eye && statusPayload.eye.id === 'conversation_eye', 'eye id should match');
  assert.ok(
    String(statusPayload.eye && statusPayload.eye.parser_type || '') === 'conversation_eye',
    'parser type should be conversation_eye'
  );

  console.log('conversation_eye_bootstrap.test.js: OK');
} catch (err) {
  console.error(`conversation_eye_bootstrap.test.js: FAIL: ${err && err.message ? err.message : err}`);
  process.exit(1);
}
