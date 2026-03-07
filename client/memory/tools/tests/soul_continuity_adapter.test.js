#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'soul', 'soul_continuity_adapter.js');

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

function run(args) {
  const proc = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-continuity-adapter-'));
  const policyPath = path.join(tmp, 'config', 'soul_continuity_adapter_policy.json');
  const stateDir = path.join(tmp, 'state');
  const adapterPath = path.join(tmp, 'adapters', 'voice_adapter.safetensors');
  const identityPath = path.join(tmp, 'IDENTITY.md');
  const constitutionPath = path.join(tmp, 'AGENT-CONSTITUTION.md');
  const soulVectorPath = path.join(tmp, 'state', 'symbiosis', 'soul_vector', 'latest.json');

  writeText(adapterPath, 'adapter-binary-data\n');
  writeText(identityPath, '# Identity\nStable persona\n');
  writeText(constitutionPath, '# Constitution\nAlignment first\n');
  writeJson(soulVectorPath, {
    continuity_fingerprint: 'fp_1234567890',
    ts: '2026-03-01T00:00:00.000Z'
  });

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    shadow_only: true,
    thresholds: {
      min_continuity_score: 0.9,
      max_regression: 0.05
    },
    scripts: {
      soul_vector_refresh_script: path.join(ROOT, 'systems', 'symbiosis', 'soul_vector_substrate.js')
    },
    paths: {
      bundle_dir: path.join(stateDir, 'soul', 'continuity_adapters', 'bundles'),
      state_path: path.join(stateDir, 'soul', 'continuity_adapters', 'state.json'),
      latest_path: path.join(stateDir, 'soul', 'continuity_adapters', 'latest.json'),
      receipts_path: path.join(stateDir, 'soul', 'continuity_adapters', 'receipts.jsonl'),
      soul_vector_latest_path: soulVectorPath,
      identity_path: identityPath,
      constitution_path: constitutionPath
    }
  });

  let out = run([
    'export',
    `--policy=${policyPath}`,
    `--adapter-path=${adapterPath}`,
    '--model=kimik2_5',
    '--format=lora'
  ]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.ok === true, 'export should pass');
  assert.ok(out.payload.bundle_id, 'export should emit bundle_id');
  const bundleId = out.payload.bundle_id;

  out = run([
    'import',
    `--policy=${policyPath}`,
    `--bundle-id=${bundleId}`,
    '--target-model=kimik3',
    '--apply=1'
  ]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.ok === true, 'import should pass');
  assert.strictEqual(out.payload.attestation_match, true);

  out = run([
    'verify-migration',
    `--policy=${policyPath}`,
    `--bundle-id=${bundleId}`,
    '--baseline-score=0.95',
    '--migration-score=0.93',
    '--strict=1'
  ]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.ok === true, 'verify should pass for low regression');

  out = run([
    'promote',
    `--policy=${policyPath}`,
    `--bundle-id=${bundleId}`
  ]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.ok === true, 'promote should pass');

  out = run([
    'verify-migration',
    `--policy=${policyPath}`,
    `--bundle-id=${bundleId}`,
    '--baseline-score=0.95',
    '--migration-score=0.80',
    '--strict=0'
  ]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.ok === false, 'verify should fail with high regression');

  out = run([
    'promote',
    `--policy=${policyPath}`,
    `--bundle-id=${bundleId}`
  ]);
  assert.notStrictEqual(out.status, 0, 'promote should fail after failing verification');
  assert.ok(out.payload && out.payload.error === 'continuity_regression_threshold_not_met');

  out = run(['status', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && Array.isArray(out.payload.bundles) && out.payload.bundles.length >= 1, 'status should list bundles');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('soul_continuity_adapter.test.js: OK');
} catch (err) {
  console.error(`soul_continuity_adapter.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
