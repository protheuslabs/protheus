#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function writeFile(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text, 'utf8');
}

function writeJson(filePath, value) {
  writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function runNode(scriptPath, args, env, cwd) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd,
    env,
    encoding: 'utf8'
  });
}

function parseJsonStdout(proc) {
  const raw = String(proc.stdout || '').trim();
  assert.ok(raw, 'expected JSON stdout');
  return JSON.parse(raw);
}

function assertOk(proc, label) {
  assert.strictEqual(proc.status, 0, `${label} failed: ${proc.stderr || proc.stdout}`);
  const out = parseJsonStdout(proc);
  assert.strictEqual(out.ok, true, `${label} expected ok=true`);
  return out;
}

function run() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const helixScript = path.join(repoRoot, 'systems', 'helix', 'helix_controller.js');
  const eyeScript = path.join(repoRoot, 'systems', 'eye', 'eye_kernel.js');
  const tmpRoot = fs.mkdtempSync(path.join(repoRoot, 'tmp', 'helix-controller-'));
  const fixtureRoot = path.join(tmpRoot, 'fixture');
  const stateDir = path.join(tmpRoot, 'state', 'helix');
  const codexPath = path.join(tmpRoot, 'codex.helix');
  const constitutionPath = path.join(tmpRoot, 'constitution.md');
  const soulStatePath = path.join(tmpRoot, 'state', 'security', 'soul_token_guard.json');
  const helixPolicyPath = path.join(tmpRoot, 'config', 'helix_policy.json');
  const eyePolicyPath = path.join(tmpRoot, 'config', 'eye_policy.json');

  writeFile(constitutionPath, '# Constitution\nnever bypass root\n');
  writeJson(soulStatePath, {
    instance_id: 'test_instance',
    fingerprint: 'fp_test'
  });
  writeFile(path.join(fixtureRoot, 'alpha.txt'), 'alpha-v1\n');
  writeFile(path.join(fixtureRoot, 'beta.txt'), 'beta-v1\n');

  writeJson(helixPolicyPath, {
    version: '1.0-test',
    enabled: true,
    shadow_only: true,
    codex: {
      codex_path: codexPath,
      key_env: 'HELIX_CODEX_KEY',
      constitution_path: constitutionPath,
      soul_token_state_path: soulStatePath,
      bootstrap_truths: ['preserve_root', 'preserve_user']
    },
    strands: {
      roots: [fixtureRoot],
      include_ext: ['.txt'],
      exclude_paths: []
    },
    sentinel: {
      enabled: true,
      force_confirmed_malice: false,
      max_manifest_age_minutes: 1440,
      thresholds: {
        stasis_mismatch_count: 1,
        malice_mismatch_count: 99,
        confirmed_malice_score: 50
      }
    },
    outputs: {
      emit_events: true,
      emit_obsidian_projection: true
    },
    integration: {
      eye_gate_mode: 'shadow_advisory'
    }
  });

  writeJson(eyePolicyPath, {
    version: '1.0-test',
    default_decision: 'deny',
    clearance_levels: ['L0', 'L1', 'L2', 'L3'],
    risk: {
      escalate: ['medium'],
      deny: ['high', 'critical']
    },
    budgets: {
      global_daily_tokens: 10000
    },
    lanes: {
      organ: {
        enabled: true,
        min_clearance: 'L1',
        daily_tokens: 5000,
        actions: ['observe', 'plan', 'route', 'execute'],
        targets: ['spine', 'workflow', 'autonomy', 'memory', 'sensory', 'actuation']
      }
    },
    helix_attestation: {
      enabled: true,
      mode: 'enforced',
      latest_path: path.join(stateDir, 'latest.json'),
      max_staleness_sec: 3600
    }
  });

  const env = {
    ...process.env,
    HELIX_CODEX_KEY: 'helix_test_key_material',
    HELIX_POLICY_PATH: helixPolicyPath,
    HELIX_STATE_DIR: stateDir
  };

  const initOut = assertOk(runNode(helixScript, ['init'], env, repoRoot), 'helix init');
  assert.ok(initOut.codex_root_hash, 'codex root hash should be present');
  assert.strictEqual(Number(initOut.strand_count || 0), 2, 'expected two strands in fixture');

  const attestClear = assertOk(runNode(helixScript, ['attest'], env, repoRoot), 'helix attest clear');
  assert.strictEqual(attestClear.attestation_decision, 'allow');
  assert.strictEqual(attestClear.sentinel.tier, 'clear');
  assert.strictEqual(attestClear.manifest_freshness.fresh, true);

  const staleManifest = readJson(path.join(stateDir, 'manifest.json'));
  staleManifest.generated_at = new Date(Date.now() - (2 * 24 * 60 * 60 * 1000)).toISOString();
  writeJson(path.join(stateDir, 'manifest.json'), staleManifest);
  const stalePolicy = readJson(helixPolicyPath);
  stalePolicy.sentinel = stalePolicy.sentinel || {};
  stalePolicy.sentinel.max_manifest_age_minutes = 30;
  writeJson(helixPolicyPath, stalePolicy);

  const attestStale = assertOk(runNode(helixScript, ['attest'], env, repoRoot), 'helix attest stale');
  assert.strictEqual(attestStale.attestation_decision, 'escalate');
  assert.strictEqual(attestStale.sentinel.tier, 'stasis');
  assert.strictEqual(attestStale.manifest_freshness.fresh, false);
  assert.ok(
    (attestStale.verifier.reason_codes || []).includes('manifest_stale'),
    'expected manifest_stale reason code'
  );

  writeFile(path.join(fixtureRoot, 'alpha.txt'), 'alpha-v2-tampered\n');
  const attestStasis = assertOk(runNode(helixScript, ['attest'], env, repoRoot), 'helix attest stasis');
  assert.strictEqual(attestStasis.attestation_decision, 'escalate');
  assert.strictEqual(attestStasis.sentinel.tier, 'stasis');
  assert.strictEqual(attestStasis.shadow_only, true);
  assert.ok(Number(attestStasis.verifier.mismatch_count || 0) >= 1, 'expected mismatch after tamper');
  assert.strictEqual(attestStasis.quarantine.mode, 'shadow_quarantine');

  const attestMalice = parseJsonStdout(runNode(helixScript, ['attest', '--force-malice=1'], env, repoRoot));
  assert.strictEqual(attestMalice.type, 'helix_attestation');
  assert.strictEqual(attestMalice.attestation_decision, 'deny');
  assert.strictEqual(attestMalice.sentinel.tier, 'confirmed_malice');
  assert.strictEqual(attestMalice.ok, false);
  assert.ok(attestMalice.permanent_quarantine && attestMalice.permanent_quarantine.active === true, 'confirmed malice should activate permanent quarantine lane');
  assert.strictEqual(String(attestMalice.permanent_quarantine.mode || ''), 'permanent_quarantine');

  const statusOut = parseJsonStdout(runNode(helixScript, ['status', 'latest'], env, repoRoot));
  assert.strictEqual(statusOut.type, 'helix_status');
  assert.strictEqual(statusOut.tier, 'confirmed_malice');

  const eyeOut = parseJsonStdout(runNode(eyeScript, [
    'route',
    `--policy=${eyePolicyPath}`,
    '--lane=organ',
    '--target=spine',
    '--action=plan',
    '--risk=low',
    '--clearance=L2',
    '--apply=0'
  ], env, repoRoot));
  assert.strictEqual(eyeOut.type, 'eye_kernel_route');
  assert.strictEqual(eyeOut.decision, 'deny');
  assert.ok(
    (eyeOut.reasons || []).some((reason) => String(reason).startsWith('helix_')),
    'expected helix reason in Eye deny path'
  );

  console.log('helix_controller.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`helix_controller.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
