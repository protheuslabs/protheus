#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');

function fail(msg) {
  console.error(`❌ route_reflex_match_rust_parity.test.js: ${msg}`);
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
  const out = spawnSync(bin, ['route-reflex-match', `--payload-base64=${encoded}`], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  const parsed = parsePayload(out.stdout);
  if (Number(out.status) !== 0 || !parsed || typeof parsed !== 'object') {
    fail(`route-reflex-match failed: ${(out.stderr || out.stdout || '').slice(0, 260)}`);
  }
  return parsed;
}

function main() {
  ensureReleaseBinary();

  const direct = runRust({
    intent_key: 'nightly_backup',
    task_text: 'backup database now',
    routines: [
      { id: 'db_repair', status: 'enabled', tags: ['repair'] },
      { id: 'nightly_backup', status: 'enabled', tags: ['backup'] }
    ]
  });
  assert.strictEqual(direct.matched_reflex_id, 'nightly_backup');
  assert.strictEqual(direct.match_strategy, 'direct_id');

  const tag = runRust({
    intent_key: 'unrelated_intent',
    task_text: 'run emergency drift remediation playbook',
    routines: [
      { id: 'drift_guard', status: 'enabled', tags: ['drift', 'remediation'] },
      { id: 'nightly_backup', status: 'disabled', tags: ['backup'] }
    ]
  });
  assert.strictEqual(tag.matched_reflex_id, 'drift_guard');
  assert.strictEqual(tag.match_strategy, 'tag');

  const none = runRust({
    intent_key: 'unrelated_intent',
    task_text: 'do something unrelated',
    routines: [
      { id: 'nightly_backup', status: 'disabled', tags: ['backup'] }
    ]
  });
  assert.strictEqual(none.matched_reflex_id, null);
  assert.strictEqual(none.match_strategy, 'none');

  console.log('route_reflex_match_rust_parity.test.js: OK');
}

try {
  main();
} catch (err) {
  fail(err && err.message ? err.message : String(err));
}
