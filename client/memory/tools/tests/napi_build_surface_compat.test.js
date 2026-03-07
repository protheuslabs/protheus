#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'memory', 'napi_build_surface_compat.js');

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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'napi-build-surface-'));
  const policyPath = path.join(tmp, 'config', 'napi_build_surface_compat_policy.json');
  const rustStub = path.join(tmp, 'stub_rust_cmd.js');
  const matrixMd = path.join(tmp, 'docs', 'MEMORY_BUILD_SURFACE.md');
  const matrixJson = path.join(tmp, 'state', 'memory', 'napi_build_surface_compat', 'build_matrix.json');

  writeText(rustStub, `#!/usr/bin/env node
'use strict';
console.log(JSON.stringify({ ok: true, type: 'stub_rust_cmd' }));
process.exit(0);
`);
  fs.chmodSync(rustStub, 0o755);

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    default_runtime_transport: 'daemon_first',
    strict_build_requires_cargo: false,
    commands: {
      rust_build: [process.execPath, rustStub],
      rust_probe: [process.execPath, rustStub]
    },
    matrix: {
      profiles: [
        {
          id: 'daemon_first',
          role: 'production_default',
          description: 'daemon first default',
          run_command: 'node client/systems/memory/memory_recall.js query --q=probe --top=1'
        }
      ]
    },
    paths: {
      state_path: path.join(tmp, 'state', 'memory', 'napi_build_surface_compat', 'state.json'),
      latest_path: path.join(tmp, 'state', 'memory', 'napi_build_surface_compat', 'latest.json'),
      receipts_path: path.join(tmp, 'state', 'memory', 'napi_build_surface_compat', 'receipts.jsonl'),
      matrix_json_path: matrixJson,
      matrix_md_path: matrixMd
    }
  });

  let out = run(['build', `--policy=${policyPath}`, '--apply=1']);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.ok === true, 'build should pass');
  assert.strictEqual(out.payload.daemon_first_default, true, 'daemon_first default should be enforced');
  assert.strictEqual(out.payload.rust_probe_ok, true, 'rust probe should pass');
  assert.ok(fs.existsSync(matrixJson), 'matrix json should exist');
  assert.ok(fs.existsSync(matrixMd), 'matrix markdown should exist');

  out = run(['postinstall', `--policy=${policyPath}`, '--apply=1']);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.ok === true, 'postinstall should pass');
  assert.ok(out.payload.guidance && out.payload.guidance.npm_script_build_memory, 'postinstall guidance should exist');

  out = run(['status', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.ok === true, 'status should pass');
  assert.ok(out.payload.state && Number(out.payload.state.build_runs || 0) >= 1, 'build runs should be tracked');
  assert.ok(out.payload.state && Number(out.payload.state.postinstall_runs || 0) >= 1, 'postinstall runs should be tracked');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('napi_build_surface_compat.test.js: OK');
} catch (err) {
  console.error(`napi_build_surface_compat.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
