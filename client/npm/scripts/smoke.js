#!/usr/bin/env node
'use strict';

const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

const pkgRoot = path.resolve(__dirname, '..');
const cliPath = path.join(pkgRoot, 'bin', 'protheus.js');

function run(args) {
  const out = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: path.resolve(pkgRoot, '..'),
    encoding: 'utf8'
  });
  return {
    code: Number.isFinite(out.status) ? out.status : 1,
    stdout: String(out.stdout || ''),
    stderr: String(out.stderr || '')
  };
}

function main() {
  const help = run(['--help']);
  assert.strictEqual(help.code, 0, help.stderr || help.stdout);
  const combined = `${help.stdout}\n${help.stderr}`;
  assert.ok(
    combined.includes('Usage') || combined.includes('protheus'),
    'expected help output from protheus wrapper'
  );
  process.stdout.write('npm/scripts/smoke.js: OK\n');
}

try {
  main();
} catch (err) {
  process.stderr.write(`npm/scripts/smoke.js: FAIL: ${err.message}\n`);
  process.exit(1);
}
