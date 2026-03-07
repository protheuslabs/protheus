#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const PROTHEUSCTL = path.join(ROOT, 'systems', 'ops', 'protheusctl.js');

function run(args, env = {}, input) {
  const out = spawnSync(process.execPath, [PROTHEUSCTL, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    input,
    env: {
      ...process.env,
      PROTHEUS_RUNTIME_MODE: 'source',
      PROTHEUS_CTL_SECURITY_GATE_DISABLED: '1',
      PROTHEUS_CLI_SUGGESTIONS: '0',
      PROTHEUS_SKIP_SETUP: '1',
      PROTHEUS_UPDATE_CHECKER_DISABLED: '1',
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
  let out = run([], { PROTHEUS_FORCE_REPL: '1' }, 'exit\n');
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.stdout.includes('Protheus Interactive Mode'), 'repl should show interactive banner');
  assert.ok(out.stdout.includes('Exiting Protheus interactive mode.'), 'repl should exit cleanly');

  out = run(['sttaus']);
  assert.notStrictEqual(out.status, 0, 'unknown command should fail');
  assert.ok(out.stderr.includes('Did you mean') || out.stderr.includes('Unknown command'), 'unknown command should provide suggestion hint');
  assert.ok(out.stderr.includes('protheus list'), 'unknown command should suggest protheus list');

  console.log('protheus_repl_and_error_suggestions.test.js: OK');
} catch (err) {
  console.error(`protheus_repl_and_error_suggestions.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
