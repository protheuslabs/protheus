#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const GUARD = path.join(ROOT, 'systems', 'ops', 'rust_dual_logic_guard.js');
const TMP_DIR = path.join(ROOT, 'tmp', 'tests', 'rust_dual_logic_guard');
const TMP_FILE = path.join(TMP_DIR, 'tmp_guard_file.ts');
const TMP_POLICY = path.join(TMP_DIR, 'tmp_guard_policy.json');

function run(args) {
  const out = spawnSync(process.execPath, [GUARD, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      PROTHEUS_RUNTIME_MODE: 'source'
    }
  });
  return {
    status: Number.isFinite(out.status) ? Number(out.status) : 1,
    stdout: String(out.stdout || ''),
    stderr: String(out.stderr || '')
  };
}

try {
  let out = run(['check', '--strict=0']);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  let payload = JSON.parse(out.stdout);
  assert.strictEqual(payload.type, 'rust_dual_logic_guard');
  assert.ok(Array.isArray(payload.checks), 'expected checks array');

  fs.rmSync(TMP_DIR, { recursive: true, force: true });
  fs.mkdirSync(TMP_DIR, { recursive: true });
  fs.writeFileSync(TMP_FILE, 'const ROUTE_TASK_TS_FALLBACK = true;\n', 'utf8');
  fs.writeFileSync(TMP_POLICY, JSON.stringify({
    version: '1.0',
    enabled: true,
    strict_default: true,
    checks: [
      {
        id: 'tmp',
        path: path.relative(ROOT, TMP_FILE).replace(/\\/g, '/'),
        deny_regex: 'ROUTE_TASK_TS_FALLBACK\\s*=',
        description: 'tmp'
      }
    ]
  }, null, 2), 'utf8');

  out = run(['check', `--policy=${TMP_POLICY}`, '--strict=1']);
  assert.notStrictEqual(out.status, 0, 'strict mode must fail on deny pattern');
  payload = JSON.parse(out.stdout);
  assert.ok(Array.isArray(payload.violations) && payload.violations.length === 1, 'expected single violation');

  console.log('rust_dual_logic_guard.test.js: OK');
} catch (err) {
  console.error(`rust_dual_logic_guard.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
