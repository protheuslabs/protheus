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

function parseJson(proc) {
  const raw = String(proc.stdout || '').trim();
  assert.ok(raw, 'expected JSON stdout');
  return JSON.parse(raw);
}

function run(scriptPath, args, env, cwd) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd,
    env,
    encoding: 'utf8'
  });
}

function main() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const helixScript = path.join(repoRoot, 'systems', 'helix', 'helix_controller.js');
  const tmpRoot = fs.mkdtempSync(path.join(repoRoot, 'tmp', 'helix-reweave-apply-'));
  const fixtureRoot = path.join(tmpRoot, 'fixture');
  const stateDir = path.join(tmpRoot, 'state', 'helix');
  const codexPath = path.join(tmpRoot, 'codex.helix');
  const constitutionPath = path.join(tmpRoot, 'constitution.md');
  const soulStatePath = path.join(tmpRoot, 'state', 'security', 'soul_token_guard.json');
  const helixPolicyPath = path.join(tmpRoot, 'config', 'helix_policy.json');

  writeFile(constitutionPath, '# Constitution\npreserve root\n');
  writeJson(soulStatePath, { instance_id: 'test_instance', fingerprint: 'fp_test' });
  const baselineText = 'alpha-v1\n';
  writeFile(path.join(fixtureRoot, 'alpha.txt'), baselineText);

  writeJson(helixPolicyPath, {
    version: '1.0-test',
    enabled: true,
    shadow_only: true,
    advisory_mode: true,
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
    reweave: {
      snapshot_path: path.join(stateDir, 'reweave_snapshot.json'),
      receipts_path: path.join(stateDir, 'reweave_receipts.jsonl'),
      quarantine_dir: path.join(stateDir, 'reweave_quarantine'),
      require_approval_note: true,
      snapshot_on_clear_attest: true
    }
  });

  const env = {
    ...process.env,
    HELIX_CODEX_KEY: 'helix_test_key_material',
    HELIX_POLICY_PATH: helixPolicyPath,
    HELIX_STATE_DIR: stateDir
  };

  let proc = run(helixScript, ['init'], env, repoRoot);
  assert.strictEqual(proc.status, 0, proc.stderr || proc.stdout);
  let out = parseJson(proc);
  assert.strictEqual(out.ok, true);

  proc = run(helixScript, ['baseline'], env, repoRoot);
  assert.strictEqual(proc.status, 0, proc.stderr || proc.stdout);
  out = parseJson(proc);
  assert.strictEqual(out.ok, true, 'baseline should pass in shadow mode');

  writeFile(path.join(fixtureRoot, 'alpha.txt'), 'alpha-v2-tampered\n');
  proc = run(helixScript, ['attest'], env, repoRoot);
  assert.strictEqual(proc.status, 0, proc.stderr || proc.stdout);
  out = parseJson(proc);
  assert.strictEqual(out.sentinel.tier, 'stasis');

  proc = run(helixScript, ['reweave', '--apply=1', '--approval-note=incident'], env, repoRoot);
  assert.strictEqual(proc.status, 0, proc.stderr || proc.stdout);
  out = parseJson(proc);
  assert.strictEqual(out.apply_result.applied, false, 'shadow mode should block apply');
  assert.strictEqual(out.apply_result.reason, 'shadow_only_mode');

  const policy = JSON.parse(fs.readFileSync(helixPolicyPath, 'utf8'));
  policy.shadow_only = false;
  writeJson(helixPolicyPath, policy);

  proc = run(helixScript, ['reweave', '--apply=1'], env, repoRoot);
  assert.notStrictEqual(proc.status, 0, 'apply without approval note should fail');
  out = parseJson(proc);
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.apply_result.error, 'approval_note_required');

  proc = run(helixScript, ['reweave', '--apply=1', '--approval-note=recovery_approved'], env, repoRoot);
  assert.strictEqual(proc.status, 0, proc.stderr || proc.stdout);
  out = parseJson(proc);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.apply_result.applied, true);
  assert.ok(Number(out.apply_result.restored_files.length || 0) >= 1, 'expected at least one restored file');

  const restoredText = fs.readFileSync(path.join(fixtureRoot, 'alpha.txt'), 'utf8');
  assert.strictEqual(restoredText, baselineText, 'reweave apply should restore baseline content');

  proc = run(helixScript, ['attest'], env, repoRoot);
  assert.strictEqual(proc.status, 0, proc.stderr || proc.stdout);
  out = parseJson(proc);
  assert.strictEqual(out.attestation_decision, 'allow');
  assert.strictEqual(out.sentinel.tier, 'clear');

  console.log('helix_reweave_apply.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`helix_reweave_apply.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

