#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');

function fail(msg) {
  console.error(`❌ route_match_rust_parity.test.js: ${msg}`);
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
  const out = spawnSync(bin, ['route-match', `--payload-base64=${encoded}`], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  const parsed = parsePayload(out.stdout);
  if (Number(out.status) !== 0 || !parsed || typeof parsed !== 'object') {
    fail(`route-match failed: ${(out.stderr || out.stdout || '').slice(0, 260)}`);
  }
  return parsed;
}

function main() {
  ensureReleaseBinary();

  const exact = runRust({
    intent_key: 'security_scan',
    skip_habit_id: '',
    habits: [{ id: 'daily_ops' }, { id: 'security_scan' }]
  });
  assert.strictEqual(exact.matched_habit_id, 'security_scan');
  assert.strictEqual(exact.match_strategy, 'exact');

  const token = runRust({
    intent_key: 'please_run_daily_ops_now',
    skip_habit_id: '',
    habits: [{ id: 'daily_ops' }]
  });
  assert.strictEqual(token.matched_habit_id, 'daily_ops');
  assert.strictEqual(token.match_strategy, 'token');

  const skipped = runRust({
    intent_key: 'daily_ops',
    skip_habit_id: 'daily_ops',
    habits: [{ id: 'daily_ops' }]
  });
  assert.strictEqual(skipped.matched_habit_id, null);
  assert.strictEqual(skipped.match_strategy, 'none');

  console.log('route_match_rust_parity.test.js: OK');
}

try {
  main();
} catch (err) {
  fail(err && err.message ? err.message : String(err));
}
