#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function parseJson(out) {
  const lines = String(out || '').trim().split('\n').map((row) => row.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i]);
    } catch {
      // continue
    }
  }
  return null;
}

function runNode(cwd, args, env = {}) {
  return spawnSync('node', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...env
    }
  });
}

function run() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const scriptPath = path.join(repoRoot, 'systems', 'ops', 'protheus_prime_seed.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'protheus-prime-seed-'));

  const profilePath = path.join(tmp, 'protheus_prime_profile.json');
  const bridgePolicyPath = path.join(tmp, 'sovereign_blockchain_bridge_policy.json');
  const bridgePrimePath = path.join(tmp, 'bridge_prime_profile.json');
  const bridgeTemplatePath = path.join(tmp, 'bridge_bootstrap_template.json');
  const bridgeProposalsPath = path.join(tmp, 'bridge', 'proposals.jsonl');
  const bridgeBindingsPath = path.join(tmp, 'bridge', 'bindings.jsonl');
  const bridgeLatestPath = path.join(tmp, 'bridge', 'latest.json');
  const bridgeStatePath = path.join(tmp, 'bridge', 'state.json');
  const bridgeReceiptsPath = path.join(tmp, 'bridge', 'receipts.jsonl');
  const bridgeGenomePath = path.join(tmp, 'bridge', 'genome_ledger.jsonl');

  writeJson(profilePath, {
    profile_id: 'protheus-prime-test',
    version: '1.0',
    mandatory_paths: [
      'client/systems/eye/eye_kernel.ts',
      'client/systems/security/guard.ts',
      'client/systems/ops/seed_boot_probe.ts'
    ],
    mandatory_governance_paths: [
      'client/systems/eye/eye_kernel.ts',
      'client/systems/security/guard.ts'
    ],
    provision_on_bootstrap: true,
    probes: {
      seed_boot_probe: true,
      startup_attestation_verify: false
    }
  });
  writeJson(bridgePrimePath, {
    profile_id: 'bridge-prime-test',
    version: '1.0'
  });
  writeJson(bridgeTemplatePath, {
    template_id: 'wallet_birth_bootstrap_v1',
    version: '1.0'
  });
  writeJson(bridgePolicyPath, {
    version: '1.0-test',
    enabled: true,
    shadow_only: true,
    dna: {
      prime_profile_path: bridgePrimePath,
      bootstrap_template_path: bridgeTemplatePath,
      genome_ledger_path: bridgeGenomePath,
      secret_template_id: 'wallet_dna_root_v1',
      kernel_live_key_forbidden: true
    },
    state: {
      state_path: bridgeStatePath,
      latest_path: bridgeLatestPath,
      proposals_path: bridgeProposalsPath,
      bindings_path: bridgeBindingsPath,
      receipts_path: bridgeReceiptsPath
    }
  });

  const manifest = runNode(repoRoot, [scriptPath, 'manifest', `--profile=${profilePath}`]);
  assert.strictEqual(manifest.status, 0, manifest.stderr || 'manifest should pass');
  const manifestPayload = parseJson(manifest.stdout);
  assert.strictEqual(manifestPayload.profile.profile_id, 'protheus-prime-test');

  const receiptPath = path.join(tmp, 'latest.json');
  const historyPath = path.join(tmp, 'history.jsonl');
  const bootstrap = runNode(repoRoot, [scriptPath, 'bootstrap', `--profile=${profilePath}`], {
    PROTHEUS_PRIME_RECEIPT_PATH: receiptPath,
    PROTHEUS_PRIME_RECEIPT_HISTORY: historyPath,
    PROTHEUS_PRIME_PROVISION_DIR: path.join(tmp, 'provisioned'),
    SOVEREIGN_BLOCKCHAIN_BRIDGE_POLICY_PATH: bridgePolicyPath
  });
  assert.strictEqual(bootstrap.status, 0, bootstrap.stderr || 'bootstrap should pass with test profile');
  const bootstrapPayload = parseJson(bootstrap.stdout);
  assert.strictEqual(bootstrapPayload.ok, true, `bootstrap expected ok=true, got: ${JSON.stringify(bootstrapPayload)}`);
  assert.ok(bootstrapPayload.provision && bootstrapPayload.provision.ok === true, 'bootstrap should provision minimal core');
  assert.ok(Number(bootstrapPayload.provision.file_count || 0) >= 1, 'provisioned file count should be positive');
  assert.ok(bootstrapPayload.wallet_bootstrap_bridge && bootstrapPayload.wallet_bootstrap_bridge.ok === true, 'bootstrap should enqueue wallet bridge proposal');
  assert.strictEqual(String(bootstrapPayload.wallet_bootstrap_bridge.stage || ''), 'shadow_proposed', 'wallet bridge should remain shadow proposal');
  assert.ok(fs.existsSync(receiptPath), 'bootstrap receipt should be written');
  assert.ok(fs.existsSync(bridgeProposalsPath), 'bridge proposals should be written');
  const bridgeRows = fs.readFileSync(bridgeProposalsPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.ok(bridgeRows.length >= 1, 'expected at least one bridge proposal row');
  const latestBridge = bridgeRows[bridgeRows.length - 1];
  assert.strictEqual(String(latestBridge.birth_context || ''), 'bootstrap', 'bridge row should use bootstrap context');
  assert.strictEqual(String(latestBridge.instance_id || ''), 'protheus-prime-test', 'bridge row should bind to profile id');

  const packageDir = path.join(tmp, 'packages');
  const packageRun = runNode(repoRoot, [scriptPath, 'package', `--profile=${profilePath}`, '--strict=1', `--out-dir=${packageDir}`]);
  assert.strictEqual(packageRun.status, 0, packageRun.stderr || 'package should pass when bootstrap conformance is green');
  const packagePayload = parseJson(packageRun.stdout);
  assert.strictEqual(packagePayload.ok, true, 'package payload should be ok');
  assert.ok(fs.existsSync(path.join(packageDir, 'latest.json')), 'latest package pointer should be written');

  const brokenProfilePath = path.join(tmp, 'protheus_prime_profile_broken.json');
  writeJson(brokenProfilePath, {
    profile_id: 'protheus-prime-test-broken',
    version: '1.0',
    mandatory_paths: [
      'client/systems/eye/eye_kernel.ts'
    ],
    mandatory_governance_paths: [
      'client/systems/eye/eye_kernel.ts',
      'client/systems/security/DOES_NOT_EXIST.ts'
    ],
    probes: {
      seed_boot_probe: false,
      startup_attestation_verify: false
    }
  });
  const brokenBootstrap = runNode(repoRoot, [scriptPath, 'bootstrap', `--profile=${brokenProfilePath}`], {
    PROTHEUS_PRIME_RECEIPT_PATH: path.join(tmp, 'broken_receipt.json'),
    PROTHEUS_PRIME_RECEIPT_HISTORY: path.join(tmp, 'broken_history.jsonl')
  });
  assert.notStrictEqual(brokenBootstrap.status, 0, 'bootstrap should fail closed on missing governance paths');
  const brokenPayload = parseJson(brokenBootstrap.stdout);
  assert.ok(
    Array.isArray(brokenPayload && brokenPayload.missing_governance_paths)
      && brokenPayload.missing_governance_paths.length >= 1,
    'missing governance paths should be reported'
  );
  const brokenPackage = runNode(repoRoot, [scriptPath, 'package', `--profile=${brokenProfilePath}`, '--strict=1', `--out-dir=${path.join(tmp, 'broken_packages')}`]);
  assert.notStrictEqual(brokenPackage.status, 0, 'strict package should fail closed when conformance fails');

  console.log('protheus_prime_seed.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`protheus_prime_seed.test.js: FAIL: ${err && err.stack ? err.stack : err.message}`);
  process.exit(1);
}
