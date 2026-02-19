#!/usr/bin/env node
'use strict';

/**
 * state_backup.test.js
 * Deterministic contract test for systems/ops/state_backup.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'state_backup.js');
const DEST = path.join(ROOT, 'memory', 'tools', 'tests', 'temp_state_backup_dest');

function run(args) {
  const r = spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8' });
  const stdout = String(r.stdout || '').trim();
  let payload = null;
  if (stdout) {
    try { payload = JSON.parse(stdout); } catch {}
  }
  return { code: r.status ?? 1, payload, stdout, stderr: String(r.stderr || '') };
}

function clean() {
  if (fs.existsSync(DEST)) fs.rmSync(DEST, { recursive: true, force: true });
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
console.log('   STATE BACKUP TESTS');
console.log('═══════════════════════════════════════════════════════════');

test('dry-run emits valid snapshot metadata', () => {
  clean();
  const r = run(['run', '--dry-run', `--dest=${DEST}`]);
  assert.strictEqual(r.code, 0, `exit should be 0, got ${r.code} stderr=${r.stderr}`);
  assert.ok(r.payload && r.payload.ok === true, 'payload.ok should be true');
  assert.strictEqual(r.payload.dry_run, true, 'dry_run should be true');
  assert.ok(Number(r.payload.file_count) >= 0, 'file_count should be numeric');
  assert.strictEqual(fs.existsSync(DEST), false, 'dry-run should not create destination');
});

test('run writes snapshot + manifest and list sees it', () => {
  clean();
  const runRes = run(['run', `--dest=${DEST}`, '--date=2026-02-19']);
  assert.strictEqual(runRes.code, 0, `run exit should be 0, got ${runRes.code} stderr=${runRes.stderr}`);
  assert.ok(runRes.payload && runRes.payload.ok === true, 'run payload.ok should be true');
  assert.ok(runRes.payload.snapshot_id, 'snapshot_id should exist');
  const manifestPath = path.join(runRes.payload.snapshot_dir, 'manifest.json');
  assert.ok(fs.existsSync(manifestPath), 'manifest.json should exist');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.strictEqual(manifest.type, 'state_backup_snapshot');

  const listRes = run(['list', `--dest=${DEST}`, '--limit=5']);
  assert.strictEqual(listRes.code, 0, `list exit should be 0, got ${listRes.code} stderr=${listRes.stderr}`);
  assert.ok(listRes.payload && listRes.payload.ok === true, 'list payload.ok should be true');
  assert.ok(Array.isArray(listRes.payload.snapshots), 'snapshots should be an array');
  assert.ok(listRes.payload.snapshots.length >= 1, 'list should return at least one snapshot');
});

clean();

if (failed) {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('   ❌ STATE BACKUP TESTS FAILED');
  console.log('═══════════════════════════════════════════════════════════');
  process.exit(1);
}

console.log('═══════════════════════════════════════════════════════════');
console.log('   ✅ STATE BACKUP TESTS PASS');
console.log('═══════════════════════════════════════════════════════════');
