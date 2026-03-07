#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'local_runtime_partitioner.js');

function run(args, env = {}) {
  const proc = spawnSync('node', [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env }
  });
  return {
    status: Number.isFinite(Number(proc.status)) ? Number(proc.status) : 1,
    stdout: String(proc.stdout || ''),
    stderr: String(proc.stderr || '')
  };
}

function parseJson(stdout) {
  const txt = String(stdout || '').trim();
  return txt ? JSON.parse(txt) : null;
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'local-runtime-partitioner-'));
  fs.writeFileSync(path.join(tmp, 'AGENTS.md'), '# tmp\n', 'utf8');
  fs.writeFileSync(path.join(tmp, 'package.json'), '{\"name\":\"tmp\"}\n', 'utf8');
  const env = { OPENCLAW_WORKSPACE: tmp };

  let out = run(['init'], env);
  assert.strictEqual(out.status, 0, out.stderr);
  let payload = parseJson(out.stdout);
  assert.ok(payload && payload.ok === true, 'init should succeed');

  const junkClient = path.join(tmp, 'client', 'local', 'state', 'junk.json');
  const junkCore = path.join(tmp, 'core', 'local', 'cache', 'junk.bin');
  fs.mkdirSync(path.dirname(junkClient), { recursive: true });
  fs.mkdirSync(path.dirname(junkCore), { recursive: true });
  fs.writeFileSync(junkClient, '{"ok":true}\n', 'utf8');
  fs.writeFileSync(junkCore, 'x', 'utf8');

  out = run(['status'], env);
  assert.strictEqual(out.status, 0, out.stderr);
  payload = parseJson(out.stdout);
  assert.ok(payload && payload.ok === true, 'status should succeed');
  assert.ok(payload.summary && payload.summary.client.files >= 1, 'client local should contain files');
  assert.ok(payload.summary && payload.summary.core.files >= 1, 'core local should contain files');

  out = run(['reset'], env);
  assert.notStrictEqual(out.status, 0, 'reset should require explicit confirmation');

  out = run(['reset', '--confirm=RESET_LOCAL'], env);
  assert.strictEqual(out.status, 0, out.stderr);
  payload = parseJson(out.stdout);
  assert.ok(payload && payload.ok === true, 'reset should succeed with confirmation');
  assert.ok(!fs.existsSync(junkClient), 'reset should remove client-local junk');
  assert.ok(!fs.existsSync(junkCore), 'reset should remove core-local junk');
  assert.ok(fs.existsSync(path.join(tmp, 'client', 'local', 'state', '.gitkeep')), 'reset should preserve scaffold markers');
  assert.ok(fs.existsSync(path.join(tmp, 'core', 'local', 'cache', '.gitkeep')), 'reset should preserve scaffold markers');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('local_runtime_partitioner.test.js: OK');
} catch (err) {
  console.error(`local_runtime_partitioner.test.js: FAIL: ${err && err.message ? err.message : err}`);
  process.exit(1);
}
