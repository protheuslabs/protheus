#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'memory', 'rust_memory_transition_lane.js');

function run(args) {
  const r = spawnSync('node', [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8' });
  let payload = null;
  try { payload = JSON.parse(String(r.stdout || '').trim()); } catch {}
  return { status: Number.isFinite(r.status) ? r.status : 1, payload, stderr: String(r.stderr || '') };
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rust-mem-lane-'));
  const policyPath = path.join(tmp, 'policy.json');
  const stateRoot = path.join(tmp, 'state');
  const indexPath = path.join(tmp, 'MEMORY_INDEX.md');
  const probeScript = path.join(tmp, 'probe.js');

  fs.writeFileSync(indexPath, '| node_id | title | file |\n|---|---|---|\n| `n1` | n1 | `memory/2026-02-28.md` |\n');
  fs.writeFileSync(probeScript, `
const engineArg = process.argv.find((arg) => String(arg).startsWith('--engine=')) || '--engine=js';
const engine = String(engineArg.split('=')[1] || 'js');
const waitMs = engine === 'js' ? 24 : 8;
const start = Date.now();
while (Date.now() - start < waitMs) {}
if (process.env.FAIL_PROBE_ENGINE && process.env.FAIL_PROBE_ENGINE === engine) {
  console.error('forced probe failure');
  process.exit(1);
}
process.stdout.write(JSON.stringify({ ok: true, backend_used: engine, parity_error_count: 0 }) + '\\n');
`);

  writeJson(policyPath, {
    enabled: true,
    shadow_only: true,
    thresholds: {
      min_speedup_for_cutover: 1.1,
      max_parity_error_count: 0,
      min_stable_runs_for_retirement: 3
    },
    paths: {
      state_root: stateRoot,
      latest_path: path.join(stateRoot, 'latest.json'),
      receipts_path: path.join(stateRoot, 'receipts.jsonl'),
      selector_path: path.join(stateRoot, 'selector.json'),
      benchmark_path: path.join(stateRoot, 'bench.json'),
      memory_index_path: indexPath,
      rust_crate_path: path.join(ROOT, 'systems', 'rust', 'memory_box')
    },
    benchmark: {
      mode: 'probe_commands',
      timeout_ms: 8000,
      require_rust_backend_used: true,
      js_probe_command: [process.execPath, probeScript, '--engine=js'],
      js_get_probe_command: [process.execPath, probeScript, '--engine=js'],
      rust_probe_command: [process.execPath, probeScript, '--engine=rust'],
      rust_get_probe_command: [process.execPath, probeScript, '--engine=rust']
    }
  });

  let res = run(['pilot', `--policy=${policyPath}`]);
  assert.strictEqual(res.status, 0, res.stderr);
  assert.ok(res.payload && res.payload.ok === true, 'pilot should pass with crate');

  res = run(['benchmark', `--policy=${policyPath}`, '--runs=3']);
  assert.strictEqual(res.status, 0, res.stderr);
  assert.ok(res.payload && res.payload.mode === 'probe_commands', 'benchmark should report probe_commands mode');
  assert.ok(Number(res.payload.avg_speedup || 0) > 1, 'probe benchmark should show rust faster than js');
  const bench = JSON.parse(fs.readFileSync(path.join(stateRoot, 'bench.json'), 'utf8'));
  assert.ok(Array.isArray(bench.rows) && bench.rows.length >= 3, 'benchmark rows should be recorded');
  assert.strictEqual(bench.rows[0].mode, 'probe_commands');
  assert.ok(Number(bench.rows[0].query_speedup || 0) > 0, 'query_speedup should be present');
  assert.ok(Number(bench.rows[0].get_speedup || 0) > 0, 'get_speedup should be present');
  assert.strictEqual(bench.rows[0].js_probe_ok, true);
  assert.strictEqual(bench.rows[0].rust_probe_ok, true);
  assert.strictEqual(bench.rows[0].js_get_probe_ok, true);
  assert.strictEqual(bench.rows[0].rust_get_probe_ok, true);
  assert.strictEqual(bench.rows[0].probe_node_id, 'n1');
  assert.strictEqual(bench.rows[0].parity_error_count, 0);

  res = run(['auto-selector', `--policy=${policyPath}`]);
  assert.strictEqual(res.status, 0, res.stderr);
  assert.ok(res.payload && res.payload.backend === 'rust_shadow', 'auto-selector should promote rust_shadow when eligible');

  res = run(['selector', `--policy=${policyPath}`, '--backend=rust_shadow']);
  assert.strictEqual(res.status, 0, res.stderr);
  assert.ok(res.payload && res.payload.backend === 'rust_shadow', 'selector should accept rust_shadow');
  assert.strictEqual(res.payload.active_engine, 'rust', 'rust_shadow should normalize to rust active engine');

  res = run(['retire-check', `--policy=${policyPath}`]);
  assert.strictEqual(res.status, 0, res.stderr);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('rust_memory_transition_lane.test.js: OK');
} catch (err) {
  console.error(`rust_memory_transition_lane.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
