#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
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

function main() {
  const root = path.resolve(__dirname, '..', '..', '..');
  const script = path.join(root, 'systems', 'security', 'supply_chain_trust_plane.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'supply-chain-trust-'));

  const systemsDir = path.join(tmp, 'systems');
  const configDir = path.join(tmp, 'config');
  const docsDir = path.join(tmp, 'docs');
  fs.mkdirSync(systemsDir, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(docsDir, { recursive: true });
  fs.writeFileSync(path.join(systemsDir, 'lane.ts'), 'export const lane = 1;\n', 'utf8');
  fs.writeFileSync(path.join(configDir, 'base.json'), JSON.stringify({ ok: true }, null, 2), 'utf8');
  fs.writeFileSync(path.join(docsDir, 'README.md'), '# Test\n', 'utf8');

  writeJson(path.join(tmp, 'package.json'), {
    name: 'supply-chain-test',
    version: '1.0.0',
    dependencies: {
      alpha: '^1.0.0'
    },
    devDependencies: {
      beta: '^2.0.0'
    }
  });
  writeJson(path.join(tmp, 'package-lock.json'), {
    name: 'supply-chain-test',
    lockfileVersion: 3,
    packages: {
      '': {
        name: 'supply-chain-test',
        version: '1.0.0'
      },
      'node_modules/alpha': {
        version: '1.0.1',
        resolved: 'https://registry.npmjs.org/alpha/-/alpha-1.0.1.tgz',
        integrity: 'sha512-alpha'
      },
      'node_modules/beta': {
        version: '2.0.1',
        resolved: 'https://registry.npmjs.org/beta/-/beta-2.0.1.tgz',
        integrity: 'sha512-beta',
        dev: true
      }
    }
  });

  const policyPath = path.join(tmp, 'config', 'supply_chain_trust_policy.json');
  writeJson(policyPath, {
    schema_id: 'supply_chain_trust_policy',
    schema_version: '1.0',
    enabled: true,
    mode: 'enforce',
    artifact_roots: ['systems', 'config', 'docs'],
    include_extensions: ['.ts', '.js', '.json', '.md'],
    exclude_patterns: ['state/', 'memory/', 'research/', 'node_modules/', '.git/'],
    require_lockfile: true,
    lockfile_path: 'package-lock.json',
    package_json_path: 'package.json',
    sbom_from_lockfile: true,
    signature_key_env: 'SUPPLY_CHAIN_SIGNING_KEY',
    allow_dev_fallback_key: true,
    dev_fallback_key: 'test-key',
    latest_path: 'state/security/supply_chain/latest.json',
    receipts_path: 'state/security/supply_chain/receipts.jsonl',
    manifest_path: 'state/security/supply_chain/manifest.json',
    sbom_path: 'state/security/supply_chain/sbom.json',
    attestation_path: 'state/security/supply_chain/attestation.json',
    run_build_commands: false,
    build_commands: []
  });

  const env = {
    ...process.env,
    SUPPLY_CHAIN_TRUST_ROOT: tmp,
    SUPPLY_CHAIN_SIGNING_KEY: 'unit-test-signing-key'
  };

  const run = spawnSync(process.execPath, [
    script,
    'run',
    '--strict=1',
    `--policy=${policyPath}`
  ], {
    cwd: root,
    env,
    encoding: 'utf8'
  });

  assert.strictEqual(run.status, 0, run.stderr || 'supply chain run should pass strict mode');
  const payload = parseJson(run.stdout);
  assert.ok(payload && payload.ok === true, 'payload should be ok');
  assert.strictEqual(payload.signature_verified, true, 'signature should verify');
  assert.ok(Number(payload.artifact_count || 0) >= 3, 'artifact manifest should include tracked files');
  assert.ok(Number(payload.sbom_components || 0) >= 2, 'sbom should include dependencies');

  const latestPath = path.join(tmp, 'state', 'security', 'supply_chain', 'latest.json');
  const manifestPath = path.join(tmp, 'state', 'security', 'supply_chain', 'manifest.json');
  const sbomPath = path.join(tmp, 'state', 'security', 'supply_chain', 'sbom.json');
  const attestationPath = path.join(tmp, 'state', 'security', 'supply_chain', 'attestation.json');
  assert.ok(fs.existsSync(latestPath), 'latest status should be written');
  assert.ok(fs.existsSync(manifestPath), 'manifest should be written');
  assert.ok(fs.existsSync(sbomPath), 'sbom should be written');
  assert.ok(fs.existsSync(attestationPath), 'attestation should be written');

  const verifyOnly = spawnSync(process.execPath, [
    script,
    'run',
    '--strict=1',
    '--verify-only=1',
    `--policy=${policyPath}`
  ], {
    cwd: root,
    env,
    encoding: 'utf8'
  });
  assert.strictEqual(verifyOnly.status, 0, verifyOnly.stderr || 'verify-only strict run should pass');

  console.log('supply_chain_trust_plane.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`supply_chain_trust_plane.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
