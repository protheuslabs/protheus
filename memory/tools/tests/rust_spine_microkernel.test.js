#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'rust_spine_microkernel.js');

function writeText(filePath, body) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, body, 'utf8');
}

function writeJson(filePath, value) {
  writeText(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function parseJson(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function run(args, env = {}) {
  const proc = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8'
  });
  return {
    status: Number.isFinite(proc.status) ? Number(proc.status) : 1,
    stdout: String(proc.stdout || ''),
    stderr: String(proc.stderr || ''),
    payload: parseJson(proc.stdout)
  };
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rust-spine-microkernel-'));
  const policyPath = path.join(tmp, 'config', 'rust_spine_microkernel_policy.json');
  const probeScript = path.join(tmp, 'probe.js');
  const stateDir = path.join(tmp, 'state');

  writeText(probeScript, `#!/usr/bin/env node
'use strict';
const componentArg = process.argv.find((row) => String(row).startsWith('--component=')) || '--component=unknown';
const engineArg = process.argv.find((row) => String(row).startsWith('--engine=')) || '--engine=js';
const component = componentArg.slice('--component='.length);
const engine = engineArg.slice('--engine='.length);
if (process.env.FAIL_RUST_COMPONENT && engine === 'rust' && process.env.FAIL_RUST_COMPONENT === component) {
  console.error('forced rust failure');
  process.exit(2);
}
console.log(JSON.stringify({
  ok: true,
  type: 'control_plane_component_probe',
  component,
  contract_version: '1.0',
  engine
}));
`);
  fs.chmodSync(probeScript, 0o755);

  const components = ['guard', 'spawn_broker', 'model_router', 'origin_lock', 'fractal_orchestrator'].map((id) => ({
    id,
    js_command: [process.execPath, probeScript, `--component=${id}`, '--engine=js'],
    rust_command: [process.execPath, probeScript, `--component=${id}`, '--engine=rust'],
    contract_fields: ['type', 'component', 'contract_version']
  }));

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    shadow_only: true,
    thresholds: {
      min_parity_pass_rate: 1,
      min_component_parity_streak: 1,
      max_p95_latency_ms: 1000,
      max_p99_latency_ms: 1500,
      min_availability: 1
    },
    profiles: {
      initial: 'shadow_js',
      rust_spine: { rust_first: true, js_fallback: 'emergency_only' },
      emergency_js: { rust_first: false, js_fallback: 'allowed' },
      shadow_js: { rust_first: false, js_fallback: 'allowed' }
    },
    components,
    paths: {
      state_path: path.join(stateDir, 'state.json'),
      latest_path: path.join(stateDir, 'latest.json'),
      receipts_path: path.join(stateDir, 'receipts.jsonl'),
      parity_history_path: path.join(stateDir, 'parity_history.jsonl'),
      benchmark_history_path: path.join(stateDir, 'benchmark_history.jsonl'),
      rollback_history_path: path.join(stateDir, 'rollback_history.jsonl')
    }
  });

  let out = run(['parity', `--policy=${policyPath}`, '--apply=1']);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.ok === true, 'parity should pass');
  assert.strictEqual(Number(out.payload.parity_pass_rate || 0), 1, 'parity pass rate should be 1');

  out = run(['benchmark', `--policy=${policyPath}`, '--apply=1']);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.slo_pass === true, 'benchmark should pass');

  out = run(['cutover', `--policy=${policyPath}`, '--apply=1']);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.ready === true, 'cutover should be ready');
  assert.strictEqual(out.payload.active_profile, 'rust_spine', 'profile should cut over to rust');

  out = run(['route', `--policy=${policyPath}`, '--component=guard']);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.strictEqual(out.payload.chosen_engine, 'rust', 'route should choose rust');

  out = run(['parity', `--policy=${policyPath}`, '--apply=1'], { FAIL_RUST_COMPONENT: 'guard' });
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(Number(out.payload.parity_pass_rate || 1) < 1, 'forced failure should drop parity');

  out = run(['route', `--policy=${policyPath}`, '--component=guard']);
  assert.notStrictEqual(out.status, 0, 'route should block when rust unhealthy under rust_spine profile');
  assert.strictEqual(out.payload.error, 'rust_unhealthy_emergency_profile_required');

  out = run(['rollback', `--policy=${policyPath}`, '--apply=1', '--reason=test']);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.strictEqual(out.payload.active_profile, 'emergency_js', 'rollback should activate emergency profile');

  out = run(['route', `--policy=${policyPath}`, '--component=guard']);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.strictEqual(out.payload.chosen_engine, 'js', 'emergency profile should route js');

  out = run(['status', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.state, 'status should include state');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('rust_spine_microkernel.test.js: OK');
} catch (err) {
  console.error(`rust_spine_microkernel.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
