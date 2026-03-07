#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');

function fail(msg) {
  console.error(`❌ route_complexity_rust_parity.test.js: ${msg}`);
  process.exit(1);
}

function parsePayload(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function ensureReleaseBinary() {
  const out = spawnSync('cargo', ['build', '-p', 'execution_core', '--release'], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  if (Number(out.status) !== 0) {
    fail(`cargo build failed: ${(out.stderr || out.stdout || '').slice(0, 260)}`);
  }
}

function runRust(payload) {
  const bin = path.join(ROOT, 'target', 'release', 'execution_core');
  const encoded = Buffer.from(JSON.stringify(payload || {}), 'utf8').toString('base64');
  const out = spawnSync(bin, ['route-complexity', `--payload-base64=${encoded}`], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  const parsed = parsePayload(out.stdout);
  if (Number(out.status) !== 0 || !parsed || typeof parsed !== 'object') {
    fail(`route-complexity failed: ${(out.stderr || out.stdout || '').slice(0, 260)}`);
  }
  return parsed;
}

function main() {
  ensureReleaseBinary();

  const high = runRust({
    task_text: 'quick ping',
    tokens_est: 2600,
    has_match: false,
    any_trigger: false
  });
  assert.strictEqual(high.complexity, 'high');
  assert.strictEqual(high.reason, 'tokens_est_high');

  const mediumTokens = runRust({
    task_text: 'quick ping',
    tokens_est: 900,
    has_match: false,
    any_trigger: false
  });
  assert.strictEqual(mediumTokens.complexity, 'medium');
  assert.strictEqual(mediumTokens.reason, 'tokens_est_medium');

  const mediumMatch = runRust({
    task_text: 'quick ping',
    tokens_est: 10,
    has_match: true,
    any_trigger: false
  });
  assert.strictEqual(mediumMatch.complexity, 'medium');
  assert.strictEqual(mediumMatch.reason, 'has_match');

  const low = runRust({
    task_text: 'quick ping',
    tokens_est: 10,
    has_match: false,
    any_trigger: false
  });
  assert.strictEqual(low.complexity, 'low');
  assert.strictEqual(low.reason, 'default_low');

  console.log('route_complexity_rust_parity.test.js: OK');
}

try {
  main();
} catch (err) {
  fail(err && err.message ? err.message : String(err));
}
