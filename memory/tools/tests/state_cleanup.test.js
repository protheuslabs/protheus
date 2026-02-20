#!/usr/bin/env node
'use strict';

/**
 * state_cleanup.test.js
 * Deterministic contract test for systems/ops/state_cleanup.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'state_cleanup.js');
const TEMP = path.join(ROOT, 'memory', 'tools', 'tests', 'temp_state_cleanup');

function clean() {
  if (fs.existsSync(TEMP)) fs.rmSync(TEMP, { recursive: true, force: true });
}

function mkdirp(p) {
  fs.mkdirSync(p, { recursive: true });
}

function writeFile(p, body) {
  mkdirp(path.dirname(p));
  fs.writeFileSync(p, body, 'utf8');
}

function setFileAgeHours(p, hoursAgo) {
  const now = Date.now();
  const t = new Date(now - (hoursAgo * 60 * 60 * 1000));
  fs.utimesSync(p, t, t);
}

function run(args) {
  const env = {
    ...process.env,
    STATE_CLEANUP_ROOT: TEMP,
    STATE_CLEANUP_POLICY: path.join(TEMP, 'config', 'state_cleanup_policy.json'),
    STATE_CLEANUP_SKIP_GIT: '1'
  };
  const r = spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8', env });
  const stdout = String(r.stdout || '').trim();
  let payload = null;
  if (stdout) {
    try { payload = JSON.parse(stdout); } catch {}
  }
  return { code: r.status ?? 1, payload, stdout, stderr: String(r.stderr || '') };
}

function setupWorkspace() {
  clean();
  mkdirp(path.join(TEMP, 'config'));
  const policy = {
    version: '1.0',
    default_profile: 'test_profile',
    profiles: {
      test_profile: {
        description: 'Test stale cleanup profile',
        max_delete_per_run: 10,
        rules: [
          {
            path: 'state/autonomy/runs',
            max_age_hours: 24,
            suffixes: ['.jsonl']
          }
        ]
      }
    }
  };
  writeFile(path.join(TEMP, 'config', 'state_cleanup_policy.json'), JSON.stringify(policy, null, 2));
}

let failed = false;

function test(name, fn) {
  try {
    fn();
    console.log(`   ✅ ${name}`);
  } catch (err) {
    failed = true;
    console.error(`   ❌ ${name}: ${err.message}`);
  }
}

console.log('═══════════════════════════════════════════════════════════');
console.log('   STATE CLEANUP TESTS');
console.log('═══════════════════════════════════════════════════════════');

test('dry-run is default and does not delete candidates', () => {
  setupWorkspace();

  const oldA = path.join(TEMP, 'state', 'autonomy', 'runs', '2026-01-01.jsonl');
  const oldB = path.join(TEMP, 'state', 'autonomy', 'runs', '2026-01-02.jsonl');
  const fresh = path.join(TEMP, 'state', 'autonomy', 'runs', '2026-02-20.jsonl');
  const otherSuffix = path.join(TEMP, 'state', 'autonomy', 'runs', 'notes.txt');
  writeFile(oldA, '{"a":1}\n');
  writeFile(oldB, '{"b":1}\n');
  writeFile(fresh, '{"fresh":1}\n');
  writeFile(otherSuffix, 'keep');
  setFileAgeHours(oldA, 72);
  setFileAgeHours(oldB, 72);
  setFileAgeHours(fresh, 1);
  setFileAgeHours(otherSuffix, 72);

  const r = run(['run', '--profile=test_profile', '--max-delete=1']);
  assert.strictEqual(r.code, 0, `exit should be 0; stderr=${r.stderr}`);
  assert.ok(r.payload && r.payload.ok === true, 'payload.ok should be true');
  assert.strictEqual(r.payload.dry_run, true, 'dry_run should be true by default');
  assert.strictEqual(Number(r.payload.totals.candidates), 2, 'two stale .jsonl files should be candidates');
  assert.strictEqual(Number(r.payload.totals.selected), 1, 'max-delete should cap selected to 1');
  assert.strictEqual(Number(r.payload.totals.deleted), 0, 'dry-run should not delete');

  assert.ok(fs.existsSync(oldA), 'oldA should still exist after dry-run');
  assert.ok(fs.existsSync(oldB), 'oldB should still exist after dry-run');
  assert.ok(fs.existsSync(fresh), 'fresh file should still exist');
  assert.ok(fs.existsSync(otherSuffix), 'non-matching suffix should still exist');
});

test('apply deletes only stale allowlisted files', () => {
  setupWorkspace();

  const oldA = path.join(TEMP, 'state', 'autonomy', 'runs', '2026-01-01.jsonl');
  const oldB = path.join(TEMP, 'state', 'autonomy', 'runs', '2026-01-02.jsonl');
  const fresh = path.join(TEMP, 'state', 'autonomy', 'runs', '2026-02-20.jsonl');
  const otherSuffix = path.join(TEMP, 'state', 'autonomy', 'runs', 'notes.txt');
  writeFile(oldA, '{"a":1}\n');
  writeFile(oldB, '{"b":1}\n');
  writeFile(fresh, '{"fresh":1}\n');
  writeFile(otherSuffix, 'keep');
  setFileAgeHours(oldA, 72);
  setFileAgeHours(oldB, 72);
  setFileAgeHours(fresh, 1);
  setFileAgeHours(otherSuffix, 72);

  const r = run(['run', '--profile=test_profile', '--apply', '--max-delete=10']);
  assert.strictEqual(r.code, 0, `exit should be 0; stderr=${r.stderr}`);
  assert.ok(r.payload && r.payload.ok === true, 'payload.ok should be true');
  assert.strictEqual(r.payload.dry_run, false, 'dry_run should be false when --apply is set');
  assert.strictEqual(Number(r.payload.totals.deleted), 2, 'should delete two stale .jsonl files');

  assert.strictEqual(fs.existsSync(oldA), false, 'oldA should be deleted');
  assert.strictEqual(fs.existsSync(oldB), false, 'oldB should be deleted');
  assert.ok(fs.existsSync(fresh), 'fresh file should remain');
  assert.ok(fs.existsSync(otherSuffix), 'non-matching suffix should remain');
});

clean();

if (failed) {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('   ❌ STATE CLEANUP TESTS FAILED');
  console.log('═══════════════════════════════════════════════════════════');
  process.exit(1);
}

console.log('═══════════════════════════════════════════════════════════');
console.log('   ✅ STATE CLEANUP TESTS PASS');
console.log('═══════════════════════════════════════════════════════════');
