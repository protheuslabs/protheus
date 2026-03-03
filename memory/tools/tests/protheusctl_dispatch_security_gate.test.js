#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const PROTHEUSCTL = path.join(ROOT, 'systems', 'ops', 'protheusctl.js');

function run(args, env = {}) {
  const out = spawnSync(process.execPath, [PROTHEUSCTL, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...env
    }
  });
  return {
    status: Number.isFinite(out.status) ? Number(out.status) : 1,
    stdout: String(out.stdout || ''),
    stderr: String(out.stderr || '')
  };
}

try {
  let out = run(['lens', '--list']);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.stdout.includes('vikram_menon'), 'expected lens list output');

  out = run(['lens', '--list'], {
    PROTHEUS_CTL_SECURITY_COVENANT_VIOLATION: '1'
  });
  assert.notStrictEqual(out.status, 0, 'dispatch should fail closed on covenant violation');
  assert.ok(out.stderr.includes('protheusctl_dispatch_security_gate'), 'expected security gate error envelope');
  assert.ok(out.stderr.includes('security_gate_blocked'), 'expected blocked reason');

  console.log('protheusctl_dispatch_security_gate.test.js: OK');
} catch (err) {
  console.error(`protheusctl_dispatch_security_gate.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
