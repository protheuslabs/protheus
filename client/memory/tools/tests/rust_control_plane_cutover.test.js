#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'rust_control_plane_cutover.js');

function writeText(filePath, body) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, body, 'utf8');
}

function writeJson(filePath, value) {
  writeText(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function makeScript(filePath, body) {
  writeText(filePath, body);
  fs.chmodSync(filePath, 0o755);
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
    status: Number.isFinite(proc.status) ? proc.status : 1,
    stdout: String(proc.stdout || ''),
    stderr: String(proc.stderr || ''),
    payload: parseJson(proc.stdout)
  };
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rust-control-plane-cutover-'));
  const stubs = path.join(tmp, 'stubs');
  const stateDir = path.join(tmp, 'state');
  const policyPath = path.join(tmp, 'config', 'rust_control_plane_cutover_policy.json');

  const probeScript = path.join(stubs, 'probe.js');
  makeScript(probeScript, `#!/usr/bin/env node
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

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    shadow_only: true,
    thresholds: {
      min_parity_pass_rate: 1,
      max_avg_latency_delta_ms: 1000,
      min_stable_parity_runs: 1
    },
    profiles: {
      initial: 'emergency',
      default: { rust_first: true, js_fallback: 'emergency_only' },
      emergency: { rust_first: false, js_fallback: 'allowed' }
    },
    components: [
      {
        id: 'guard',
        js_command: [process.execPath, probeScript, '--component=guard', '--engine=js'],
        rust_command: [process.execPath, probeScript, '--component=guard', '--engine=rust'],
        contract_fields: ['type', 'component', 'contract_version']
      },
      {
        id: 'spawn_broker',
        js_command: [process.execPath, probeScript, '--component=spawn_broker', '--engine=js'],
        rust_command: [process.execPath, probeScript, '--component=spawn_broker', '--engine=rust'],
        contract_fields: ['type', 'component', 'contract_version']
      }
    ],
    paths: {
      state_path: path.join(stateDir, 'cutover', 'state.json'),
      latest_path: path.join(stateDir, 'cutover', 'latest.json'),
      receipts_path: path.join(stateDir, 'cutover', 'receipts.jsonl'),
      parity_history_path: path.join(stateDir, 'cutover', 'parity_history.jsonl'),
      benchmark_history_path: path.join(stateDir, 'cutover', 'benchmark_history.jsonl'),
      deprecations_path: path.join(stateDir, 'cutover', 'deprecations.json')
    }
  });

  let out = run(['parity-harness', `--policy=${policyPath}`, '--apply=1']);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.ok === true, 'parity harness should pass');
  assert.strictEqual(Number(out.payload.parity_pass_rate || 0), 1);

  out = run(['benchmark', `--policy=${policyPath}`, '--apply=1']);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.slo_pass === true, 'benchmark should pass SLO');

  out = run(['activate', `--policy=${policyPath}`, '--profile=default', '--apply=1']);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.ok === true, 'default activation should pass');

  out = run(['route', `--policy=${policyPath}`, '--component=guard']);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.strictEqual(out.payload.chosen_engine, 'rust', 'default profile should route rust-first');

  out = run(['deprecate', `--policy=${policyPath}`, '--component=guard', '--apply=1']);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.deprecated === true, 'deprecate should emit receipt');

  out = run(['activate', `--policy=${policyPath}`, '--profile=emergency', '--apply=1']);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.ok === true, 'emergency activation should pass');

  out = run(['route', `--policy=${policyPath}`, '--component=guard']);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.strictEqual(out.payload.chosen_engine, 'js', 'emergency profile should route js');

  out = run(['activate', `--policy=${policyPath}`, '--profile=default', '--apply=1']);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);

  out = run(['parity-harness', `--policy=${policyPath}`, '--apply=1'], { FAIL_RUST_COMPONENT: 'guard' });
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(Number(out.payload.parity_pass_rate || 1) < 1, 'forced rust failure should reduce parity pass rate');

  out = run(['route', `--policy=${policyPath}`, '--component=guard']);
  assert.notStrictEqual(out.status, 0, 'default profile should block js fallback when rust unhealthy');
  assert.strictEqual(out.payload.reason, 'rust_unhealthy_emergency_profile_required');

  out = run(['status', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.state, 'status should expose state');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('rust_control_plane_cutover.test.js: OK');
} catch (err) {
  console.error(`rust_control_plane_cutover.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
