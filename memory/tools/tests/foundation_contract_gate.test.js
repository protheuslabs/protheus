#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'foundation_contract_gate.js');

function parseJson(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function main() {
  const run = spawnSync(process.execPath, [SCRIPT, 'run', '--strict=1'], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  assert.strictEqual(run.status, 0, run.stderr || 'foundation contract gate should pass');
  const payload = parseJson(run.stdout);
  assert.ok(payload && payload.ok === true, 'gate payload should be ok');
  assert.ok(Array.isArray(payload.checks) && payload.checks.length > 0, 'checks missing');
  console.log('foundation_contract_gate.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`foundation_contract_gate.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
