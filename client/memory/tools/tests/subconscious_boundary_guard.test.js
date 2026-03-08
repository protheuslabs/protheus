#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'subconscious_boundary_guard.js');

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

function mkdirp(p) {
  fs.mkdirSync(p, { recursive: true });
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'subconscious-boundary-'));
  fs.writeFileSync(path.join(tmp, 'AGENTS.md'), '# tmp\n', 'utf8');
  fs.writeFileSync(path.join(tmp, 'package.json'), '{"name":"tmp"}\n', 'utf8');

  mkdirp(path.join(tmp, 'client', 'systems', 'ops'));
  mkdirp(path.join(tmp, 'client', 'lib'));

  fs.writeFileSync(
    path.join(tmp, 'client', 'systems', 'ops', 'safe.ts'),
    'export function ok(){ return "surface-only"; }\n',
    'utf8'
  );

  const env = { OPENCLAW_WORKSPACE: tmp };

  let out = run(['check', '--strict=1'], env);
  assert.strictEqual(out.status, 0, out.stderr);
  let payload = parseJson(out.stdout);
  assert.ok(payload && payload.ok === true, 'baseline strict check should pass');
  assert.ok(payload.checks && payload.checks.no_subconscious_authority_patterns_in_client === true);

  fs.writeFileSync(
    path.join(tmp, 'client', 'systems', 'ops', 'violating.ts'),
    'const action = "persistent_until_ack";\nexport { action };\n',
    'utf8'
  );

  out = run(['check', '--strict=1'], env);
  assert.notStrictEqual(out.status, 0, 'strict check should fail on forbidden pattern');
  payload = parseJson(out.stdout);
  assert.ok(payload && payload.ok === false, 'payload should be fail in strict mode');
  assert.ok(payload.checks && payload.checks.no_subconscious_authority_patterns_in_client === false);
  assert.ok(Array.isArray(payload.violations) && payload.violations.length >= 1);

  out = run(['status'], env);
  assert.strictEqual(out.status, 0, out.stderr);
  payload = parseJson(out.stdout);
  assert.ok(payload && payload.type === 'subconscious_boundary_guard', 'status should return guard payload');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('subconscious_boundary_guard.test.js: OK');
} catch (err) {
  console.error(`subconscious_boundary_guard.test.js: FAIL: ${err && err.message ? err.message : err}`);
  process.exit(1);
}
