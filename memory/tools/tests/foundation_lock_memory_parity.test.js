#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const MEMORY_CLI = path.join(ROOT, 'crates', 'memory', 'Cargo.toml');

let failed = false;

function runTest(name, fn) {
  try {
    fn();
    console.log(`   ✅ ${name}`);
  } catch (err) {
    failed = true;
    console.error(`   ❌ ${name}: ${err && err.message ? err.message : err}`);
  }
}

function parseJson(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function runMemoryCli(args, env = {}) {
  return spawnSync('cargo', ['run', '--quiet', '--manifest-path', MEMORY_CLI, '--bin', 'memory-cli', '--', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...env
    }
  });
}

function jsRetention(ageDays, repetitions, lambda) {
  const safeAge = Math.max(0, Number(ageDays));
  const safeReps = Math.max(1, Number(repetitions));
  const boost = 1 + Math.log(safeReps);
  const denom = Math.max(0.00001, Math.max(0.0001, Number(lambda)) / boost);
  return Math.exp(-denom * safeAge);
}

console.log('═══════════════════════════════════════════════════════════');
console.log('   FOUNDATION LOCK MEMORY PARITY TESTS');
console.log('═══════════════════════════════════════════════════════════');

runTest('ebbinghaus parity between Rust core and JS formula', () => {
  const out = runMemoryCli(['ebbinghaus-score', '--age-days=3', '--repetitions=4', '--lambda=0.02']);
  assert.strictEqual(out.status, 0, `ebbinghaus command failed: ${out.stderr}`);
  const payload = parseJson(out.stdout);
  assert.ok(payload && payload.ok === true, 'expected ok=true');
  const rustScore = Number(payload.retention_score);
  const jsScore = jsRetention(3, 4, 0.02);
  assert.ok(Math.abs(rustScore - jsScore) < 1e-9, `parity mismatch rust=${rustScore} js=${jsScore}`);
});

runTest('crdt exchange deterministic merge parity', () => {
  const payload = JSON.stringify({
    left: {
      topic: { value: 'alpha', clock: 1, node: 'n1' }
    },
    right: {
      topic: { value: 'beta', clock: 2, node: 'n2' }
    }
  });
  const out = runMemoryCli(['crdt-exchange', `--payload=${payload}`]);
  assert.strictEqual(out.status, 0, `crdt command failed: ${out.stderr}`);
  const parsed = parseJson(out.stdout);
  assert.ok(parsed && parsed.ok === true, 'expected ok=true');
  assert.strictEqual(parsed.merged.topic.value, 'beta');
  assert.strictEqual(Number(parsed.merged.topic.clock), 2);
});

runTest('recall + ingest + compress operate via Rust store', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'foundation-memory-db-'));
  const dbPath = path.join(tmp, 'memory.sqlite');
  const env = {
    PROTHEUS_MEMORY_DB_PATH: dbPath
  };

  let out = runMemoryCli(['ingest', '--id=memory://foundation-1', '--content=foundation recall sample', '--tags=foundation,parity', '--repetitions=2', '--lambda=0.02'], env);
  assert.strictEqual(out.status, 0, `ingest failed: ${out.stderr}`);
  let parsed = parseJson(out.stdout);
  assert.ok(parsed && parsed.ok === true, 'ingest should succeed');

  out = runMemoryCli(['recall', '--query=foundation', '--limit=5'], env);
  assert.strictEqual(out.status, 0, `recall failed: ${out.stderr}`);
  parsed = parseJson(out.stdout);
  assert.ok(parsed && parsed.ok === true, 'recall should succeed');
  assert.ok(Number(parsed.hit_count || 0) >= 1, 'recall should return at least one hit');

  out = runMemoryCli(['compress', '--aggressive=0'], env);
  assert.strictEqual(out.status, 0, `compress failed: ${out.stderr}`);
  parsed = parseJson(out.stdout);
  assert.ok(parsed && parsed.ok === true, 'compress should succeed');
  assert.ok(Number.isFinite(Number(parsed.compacted_rows)), 'compress should return compacted_rows');
});

if (failed) {
  process.exit(1);
}

console.log('foundation_lock_memory_parity.test.js: OK');
