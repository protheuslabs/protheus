#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'security', 'post_quantum_migration_lane.js');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
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
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  return {
    status: r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    payload: parseJson(r.stdout)
  };
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pq-migration-'));
  try {
    const policyPath = path.join(tmp, 'config', 'post_quantum_migration_policy.json');
    const keyPolicyPath = path.join(tmp, 'config', 'key_lifecycle_policy.json');
    const cryptoContractPath = path.join(tmp, 'config', 'crypto_agility_contract.json');
    const statePath = path.join(tmp, 'state', 'pq', 'state.json');
    const latestPath = path.join(tmp, 'state', 'pq', 'latest.json');
    const receiptsPath = path.join(tmp, 'state', 'pq', 'receipts.jsonl');
    const surfaceManifestPath = path.join(tmp, 'state', 'pq', 'surface_manifest.json');
    const criticalDir = path.join(tmp, 'scan');

    fs.mkdirSync(criticalDir, { recursive: true });
    fs.writeFileSync(
      path.join(criticalDir, 'crypto_lane.ts'),
      [
        'const legacy = "sha256";',
        'const migrated = "blake3";',
        'const marker = "post_quantum";',
        'const hash = "kangarootwelve";'
      ].join('\n'),
      'utf8'
    );

    writeJson(keyPolicyPath, {
      schema_id: 'key_lifecycle_policy',
      schema_version: '1.0',
      allowed_algorithms: ['ed25519', 'rsa-4096', 'pq-dilithium3']
    });

    writeJson(cryptoContractPath, {
      schema_id: 'crypto_agility_contract',
      schema_version: '1.0',
      migration_tracks: {
        ed25519: { target: 'pq-dilithium3', status: 'planned' },
        'rsa-4096': { target: 'pq-dilithium3', status: 'planned' },
        'pq-dilithium3': { target: 'pq-dilithium3', status: 'active' }
      }
    });

    writeJson(policyPath, {
      version: '1.0',
      enabled: true,
      shadow_only: false,
      defensive_only: true,
      minimum_coverage_ratio: 0.9,
      soak_hours: 72,
      algorithms: {
        signing_targets: ['pq-sphincs+-sha2-192f-robust', 'pq-dilithium3'],
        hashing_targets: ['blake3', 'kangarootwelve']
      },
      hash_pattern_tokens: ['sha256'],
      pq_marker_tokens: ['post_quantum', 'blake3', 'kangarootwelve'],
      paths: {
        key_lifecycle_policy_path: keyPolicyPath,
        crypto_agility_contract_path: cryptoContractPath,
        state_path: statePath,
        latest_path: latestPath,
        receipts_path: receiptsPath,
        surface_manifest_path: surfaceManifestPath
      },
      critical_paths: [criticalDir, keyPolicyPath, cryptoContractPath],
      scan_extensions: ['.ts', '.json']
    });

    let res = run(['run', '--apply=1', `--policy=${policyPath}`]);
    assert.strictEqual(res.status, 0, `run should pass: ${res.stderr}`);
    assert.ok(res.payload && res.payload.ok === true, 'run payload should be ok');
    assert.strictEqual(res.payload.apply_allowed, true, 'apply should be allowed');
    assert.strictEqual(res.payload.apply_written, true, 'run should write migration updates');
    assert.strictEqual(res.payload.strict_ready, true, 'run should be strict-ready');
    assert.ok(Number(res.payload.coverage_ratio || 0) >= 0.9, 'coverage ratio should meet threshold');

    res = run(['verify', '--strict=1', `--policy=${policyPath}`]);
    assert.strictEqual(res.status, 0, `verify strict should pass: ${res.stderr}`);
    assert.ok(res.payload && res.payload.ok === true, 'verify payload should be ok');
    assert.ok(res.payload.checks && res.payload.checks.coverage_ratio_ok === true, 'verify should enforce coverage ratio');
    assert.ok(res.payload.checks && res.payload.checks.key_targets_present === true, 'verify should enforce key targets');
    assert.ok(res.payload.checks && res.payload.checks.crypto_tracks_present === true, 'verify should enforce migration tracks');

    res = run(['status', `--policy=${policyPath}`]);
    assert.strictEqual(res.status, 0, `status should pass: ${res.stderr}`);
    assert.ok(res.payload && res.payload.ok === true, 'status payload should be ok');
    assert.ok(res.payload.state && Number(res.payload.state.runs || 0) >= 1, 'state should record run count');

    const keyPolicy = JSON.parse(fs.readFileSync(keyPolicyPath, 'utf8'));
    assert.ok(Array.isArray(keyPolicy.allowed_algorithms), 'key policy should contain algorithms');
    assert.ok(
      keyPolicy.allowed_algorithms.some((row) => String(row).includes('sphincs') && String(row).includes('192f')),
      'key policy should include normalized SPHINCS target'
    );

    const contract = JSON.parse(fs.readFileSync(cryptoContractPath, 'utf8'));
    assert.ok(contract.migration_tracks && contract.migration_tracks.ecdsa, 'crypto contract should include ecdsa migration track');
    assert.ok(
      Object.keys(contract.migration_tracks || {}).some((row) => String(row).includes('sphincs') && String(row).includes('192f')),
      'crypto contract should include sphincs migration track'
    );

    const receiptLines = fs.readFileSync(receiptsPath, 'utf8').split('\n').filter(Boolean);
    assert.ok(receiptLines.length >= 2, 'expected run + verify receipts');

    console.log('post_quantum_migration_lane.test.js: OK');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

try {
  main();
} catch (err) {
  console.error(`post_quantum_migration_lane.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
