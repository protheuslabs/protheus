#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');

function run(args = []) {
  const out = spawnSync(process.execPath, [path.join(ROOT, 'systems/browser/browser_text_diff_lane.js'), ...args], {
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
  const textRes = run(['text', '--url=https://example.com', '--html=<html><body><h1>Hello</h1><p>World</p></body></html>']);
  assert.strictEqual(textRes.status, 0, textRes.stderr);
  assert.strictEqual(textRes.payload.ok, true);
  assert.strictEqual(textRes.payload.payload.token_efficient, true);
  assert.ok(Number(textRes.payload.payload.token_estimate || 0) > 0);

  const diffRes = run(['diff', '--before=line one\nline two', '--after=line one\nline three']);
  assert.strictEqual(diffRes.status, 0, diffRes.stderr);
  assert.strictEqual(diffRes.payload.ok, true);
  assert.strictEqual(diffRes.payload.payload.changed, true);
  assert.ok(Array.isArray(diffRes.payload.payload.added));

  console.log('browser_text_diff_lane.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`browser_text_diff_lane.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
