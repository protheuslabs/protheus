#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const MANIFEST = path.join(ROOT, 'crates', 'red_legion', 'Cargo.toml');
const { runChaosGame } = require(path.join(ROOT, 'systems', 'red_legion', 'index.js'));

function fail(msg) {
  console.error(`❌ red_legion_phase2_rust_parity.test.js: ${msg}`);
  process.exit(1);
}

function parseJsonPayload(raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function ensureReleaseBinary() {
  const out = spawnSync('cargo', ['build', '--manifest-path', MANIFEST, '--release'], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  if (Number(out.status) !== 0) {
    fail(`cargo build failed: ${(out.stderr || out.stdout || '').slice(0, 260)}`);
  }
}

function runDirectCargo(request) {
  const requestB64 = Buffer.from(JSON.stringify(request), 'utf8').toString('base64');
  const out = spawnSync('cargo', [
    'run',
    '--quiet',
    '--manifest-path',
    MANIFEST,
    '--bin',
    'red_legion_core',
    '--',
    'run',
    `--request-base64=${requestB64}`
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024
  });
  if (Number(out.status) !== 0) {
    fail(`direct cargo run failed: ${(out.stderr || out.stdout || '').slice(0, 260)}`);
  }
  const payload = parseJsonPayload(out.stdout);
  if (!payload || typeof payload !== 'object') {
    fail('direct cargo payload invalid');
  }
  return payload;
}

function round3(v) {
  return Math.round(Number(v || 0) * 1000) / 1000;
}

function normalizeReceipt(raw) {
  return {
    mission_id: String(raw && raw.mission_id || ''),
    doctrine_id: String(raw && raw.doctrine_id || ''),
    resilient: Boolean(raw && raw.resilient),
    fail_closed: Boolean(raw && raw.fail_closed),
    sovereignty_index_pct: round3(raw && raw.sovereignty_index_pct),
    drift_score_pct: round3(raw && raw.drift_score_pct),
    telemetry_overhead_ms: round3(raw && raw.telemetry_overhead_ms),
    battery_pct_24h: round3(raw && raw.battery_pct_24h),
    hooks_fired: Array.isArray(raw && raw.hooks_fired) ? raw.hooks_fired.slice().sort() : [],
    invariants: Array.isArray(raw && raw.invariants)
      ? raw.invariants.map((row) => ({
        id: String(row && row.id || ''),
        passed: Boolean(row && row.passed),
        reason: String(row && row.reason || '')
      }))
      : [],
    receipt_digest: String(raw && raw.receipt_digest || '')
  };
}

function buildRequest(seed) {
  return {
    mission_id: `rl_parity_${seed}`,
    cycles: 160000 + (seed * 2500),
    inject_fault_every: 350 + (seed % 6) * 70,
    enforce_fail_closed: true,
    event_seed: 1000 + seed * 33
  };
}

function main() {
  ensureReleaseBinary();

  for (let i = 0; i < 18; i += 1) {
    const req = buildRequest(i + 1);
    const wrapper = runChaosGame(req, { allow_cli_fallback: true });
    if (!wrapper || wrapper.ok !== true || !wrapper.payload || typeof wrapper.payload !== 'object') {
      fail(`wrapper run failed case ${i}: ${JSON.stringify(wrapper || {})}`);
    }

    const direct = runDirectCargo(req);
    assert.deepStrictEqual(normalizeReceipt(wrapper.payload), normalizeReceipt(direct), `wrapper/direct parity mismatch case ${i}`);

    const repeat = runChaosGame(req, { allow_cli_fallback: true });
    assert.deepStrictEqual(normalizeReceipt(repeat.payload), normalizeReceipt(wrapper.payload), `non-deterministic repeat case ${i}`);
  }

  const failClosedReq = {
    mission_id: 'rl_fail_closed_probe',
    cycles: 220000,
    inject_fault_every: 500,
    enforce_fail_closed: true,
    event_seed: 1000
  };
  const failClosedOut = runChaosGame(failClosedReq, { allow_cli_fallback: true });
  if (!failClosedOut || failClosedOut.ok !== true || !failClosedOut.payload || typeof failClosedOut.payload !== 'object') {
    fail(`fail-closed probe failed: ${JSON.stringify(failClosedOut || {})}`);
  }
  assert.strictEqual(Boolean(failClosedOut.payload.fail_closed), true, 'fail_closed should trigger under stressed probe');
  assert.strictEqual(Boolean(failClosedOut.payload.resilient), false, 'resilient must drop when fail_closed is true');

  console.log('red_legion_phase2_rust_parity.test.js: OK');
}

try {
  main();
} catch (err) {
  fail(err && err.message ? err.message : String(err));
}
