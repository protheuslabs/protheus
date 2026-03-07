#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const { runMobileCycle } = require(path.join(ROOT, 'systems', 'mobile', 'index.js'));

function fail(msg) {
  console.error(`❌ mobile_phase8_rust_parity.test.js: ${msg}`);
  process.exit(1);
}

function parseJson(stdout) {
  const raw = String(stdout || '').trim();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch {}
  const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function ensureReleaseBinary() {
  const out = spawnSync('cargo', ['build', '--manifest-path', 'core/layer0/mobile/Cargo.toml', '--release'], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  if (Number(out.status) !== 0) {
    fail(`cargo build failed: ${(out.stderr || out.stdout || '').slice(0, 300)}`);
  }
}

function runDirect(requestJson) {
  const encoded = Buffer.from(String(requestJson || '{}'), 'utf8').toString('base64');
  const out = spawnSync('cargo', [
    'run',
    '--quiet',
    '--manifest-path',
    'core/layer0/mobile/Cargo.toml',
    '--bin',
    'mobile_core',
    '--',
    'run',
    `--request-base64=${encoded}`
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024
  });
  if (Number(out.status) !== 0) {
    return {
      ok: false,
      error: String(out.stderr || out.stdout || '').slice(0, 260)
    };
  }
  const payload = parseJson(out.stdout);
  return payload && typeof payload === 'object'
    ? { ok: true, payload }
    : { ok: false, error: 'direct_parse_failed' };
}

function round3(v) {
  return Math.round(Number(v || 0) * 1000) / 1000;
}

function normalize(payload) {
  return {
    cycle_id: String(payload && payload.cycle_id || ''),
    battery_pct_24h: round3(payload && payload.battery_pct_24h),
    battery_budget_pct_24h: round3(payload && payload.battery_budget_pct_24h),
    within_budget: Boolean(payload && payload.within_budget),
    fail_closed: Boolean(payload && payload.fail_closed),
    subsystem_status: Array.isArray(payload && payload.subsystem_status) ? payload.subsystem_status.slice() : [],
    sovereignty_index_pct: round3(payload && payload.sovereignty_index_pct),
    digest: String(payload && payload.digest || '')
  };
}

function seeded(seed) {
  let x = (seed >>> 0) ^ 0x9e3779b9;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 0xffffffff;
  };
}

function buildCase(seed) {
  const rnd = seeded(seed + 307);
  return {
    cycle_id: `mobile_${seed}`,
    cycles: 60000 + Math.floor(rnd() * 180000),
    run_swarm: rnd() > 0.2,
    run_red_legion: rnd() > 0.15,
    run_observability: rnd() > 0.2,
    run_graph: rnd() > 0.1,
    run_execution: rnd() > 0.1,
    run_vault: rnd() > 0.15,
    run_pinnacle: rnd() > 0.2
  };
}

function main() {
  ensureReleaseBinary();

  const fixedCases = [
    {
      cycle_id: 'mobile_all_on',
      cycles: 120000,
      run_swarm: true,
      run_red_legion: true,
      run_observability: true,
      run_graph: true,
      run_execution: true,
      run_vault: true,
      run_pinnacle: true
    },
    {
      cycle_id: 'mobile_core_only',
      cycles: 90000,
      run_swarm: false,
      run_red_legion: false,
      run_observability: false,
      run_graph: true,
      run_execution: true,
      run_vault: true,
      run_pinnacle: true
    }
  ];

  const generated = Array.from({ length: 10 }, (_, idx) => buildCase(idx + 1));
  const allCases = fixedCases.concat(generated);

  for (const request of allCases) {
    const requestJson = JSON.stringify(request);
    const wrapper = runMobileCycle(requestJson, { allow_cli_fallback: true });
    if (!wrapper || wrapper.ok !== true || !wrapper.payload || typeof wrapper.payload !== 'object') {
      fail(`wrapper run failed for ${request.cycle_id}: ${JSON.stringify(wrapper || {})}`);
    }

    const direct = runDirect(requestJson);
    if (!direct.ok || !direct.payload) {
      fail(`direct run failed for ${request.cycle_id}: ${JSON.stringify(direct || {})}`);
    }

    const normalizedWrapper = normalize(wrapper.payload);
    const normalizedDirect = normalize(direct.payload);
    assert.deepStrictEqual(normalizedWrapper, normalizedDirect, `parity mismatch for ${request.cycle_id}`);

    const repeat = runMobileCycle(requestJson, { allow_cli_fallback: true });
    assert.ok(repeat && repeat.ok === true && repeat.payload, `repeat wrapper failed for ${request.cycle_id}`);
    assert.deepStrictEqual(normalize(repeat.payload), normalizedWrapper, `determinism mismatch for ${request.cycle_id}`);
  }

  console.log('mobile_phase8_rust_parity.test.js: OK');
}

try {
  main();
} catch (err) {
  fail(err && err.message ? err.message : String(err));
}
