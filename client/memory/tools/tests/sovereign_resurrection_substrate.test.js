#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'continuity', 'sovereign_resurrection_substrate.js');

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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-resurrection-substrate-'));
  const policyPath = path.join(tmp, 'config', 'sovereign_resurrection_substrate_policy.json');
  const stubScript = path.join(tmp, 'stub_lane.js');
  const stubLog = path.join(tmp, 'state', 'stub_log.jsonl');

  writeText(stubScript, `#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const mode = String(process.argv[2] || '');
const bundleArg = process.argv.find((row) => String(row).startsWith('--bundle-id=')) || '--bundle-id=bundle_missing';
const bundleId = bundleArg.slice('--bundle-id='.length);
const out = mode === 'cold_archive'
  ? { ok: true, type: 'cold_archive', archived_files: 5 }
  : mode === 'quantum_attest'
    ? { ok: true, type: 'quantum_attest', strict_ready: true }
    : mode === 'resurrection_bundle'
      ? { ok: true, type: 'resurrection_bundle', bundle_id: bundleId, payload_hash: 'abc123' }
      : mode === 'resurrection_verify'
        ? { ok: true, type: 'resurrection_verify', bundle_id: bundleId, verified: true }
        : mode === 'resurrection_restore_preview'
          ? { ok: true, type: 'resurrection_restore_preview', bundle_id: bundleId, preview: true }
          : { ok: false, error: 'unknown_mode', mode };
if (process.env.SRS_STUB_LOG) {
  fs.mkdirSync(path.dirname(process.env.SRS_STUB_LOG), { recursive: true });
  fs.appendFileSync(process.env.SRS_STUB_LOG, JSON.stringify({ ts: new Date().toISOString(), mode, bundle_id: bundleId }) + '\\n');
}
console.log(JSON.stringify(out));
process.exit(out.ok ? 0 : 1);
`);
  fs.chmodSync(stubScript, 0o755);

  const idA = path.join(tmp, 'identity', 'a.json');
  const idB = path.join(tmp, 'identity', 'b.json');
  const idC = path.join(tmp, 'identity', 'c.json');
  writeJson(idA, { id: 'a', value: 1 });
  writeJson(idB, { id: 'b', value: 2 });
  writeJson(idC, { id: 'c', value: 3 });

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    shadow_only: true,
    continuity_identity_sources: [idA, idB, idC],
    drill: {
      default_target_host: 'drill_host',
      default_bundle_prefix: 'srs'
    },
    commands: {
      cold_archive: [process.execPath, stubScript, 'cold_archive'],
      quantum_attest: [process.execPath, stubScript, 'quantum_attest'],
      resurrection_bundle: [process.execPath, stubScript, 'resurrection_bundle'],
      resurrection_verify: [process.execPath, stubScript, 'resurrection_verify'],
      resurrection_restore_preview: [process.execPath, stubScript, 'resurrection_restore_preview']
    },
    paths: {
      state_path: path.join(tmp, 'state', 'srs', 'state.json'),
      latest_path: path.join(tmp, 'state', 'srs', 'latest.json'),
      receipts_path: path.join(tmp, 'state', 'srs', 'receipts.jsonl'),
      drills_path: path.join(tmp, 'state', 'srs', 'drills.jsonl')
    }
  });

  const env = { SRS_STUB_LOG: stubLog };

  let out = run(['package', `--policy=${policyPath}`, '--bundle-id=test_bundle', '--apply=1'], env);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.ok === true, 'package should pass');
  assert.strictEqual(out.payload.bundle_id, 'test_bundle');
  assert.ok(String(out.payload.continuity_hash || '').length >= 16, 'continuity hash should exist');
  assert.strictEqual(out.payload.cold_archive_ok, true);
  assert.strictEqual(out.payload.quantum_attestation_ok, true);
  assert.strictEqual(out.payload.resurrection_bundle_ok, true);
  assert.strictEqual(out.payload.resurrection_verify_ok, true);

  out = run(['drill', `--policy=${policyPath}`, '--bundle-id=drill_bundle', '--target-host=host_a', '--apply=1'], env);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.ok === true, 'drill should pass');
  assert.strictEqual(out.payload.bundle_id, 'drill_bundle');
  assert.strictEqual(out.payload.continuity_match, true, 'drill should have continuity match');

  out = run(['status', `--policy=${policyPath}`], env);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.ok === true, 'status should pass');
  assert.ok(out.payload.state && Number(out.payload.state.package_runs || 0) >= 1, 'state should track package runs');
  assert.ok(out.payload.state && Number(out.payload.state.drill_runs || 0) >= 1, 'state should track drill runs');

  const lines = fs.readFileSync(stubLog, 'utf8').split('\n').filter(Boolean);
  assert.ok(lines.length >= 5, 'stub command should be invoked for all lanes');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('sovereign_resurrection_substrate.test.js: OK');
} catch (err) {
  console.error(`sovereign_resurrection_substrate.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
