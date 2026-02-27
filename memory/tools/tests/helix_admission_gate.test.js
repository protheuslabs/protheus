#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'helix', 'helix_admission_gate.js');
const HELIX_SCRIPT = path.join(ROOT, 'systems', 'helix', 'helix_controller.js');

function writeText(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, String(text), 'utf8');
}

function writeJson(filePath, payload) {
  writeText(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

function run(script, args, env) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8'
  });
}

function parseJson(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const lines = text.split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'helix-admission-'));
  const codexPath = path.join(tmp, 'codex.helix');
  const helixPolicyPath = path.join(tmp, 'config', 'helix_policy.json');
  const admissionPolicyPath = path.join(tmp, 'config', 'helix_admission_policy.json');
  const stateDir = path.join(tmp, 'state', 'helix');
  const fixtureRoot = path.join(tmp, 'fixture');
  const constitutionPath = path.join(tmp, 'constitution.md');
  const soulStatePath = path.join(tmp, 'state', 'security', 'soul_token_guard.json');

  writeText(constitutionPath, '# Constitution\n');
  writeJson(soulStatePath, { instance_id: 'test', fingerprint: 'fp' });
  writeText(path.join(fixtureRoot, 'alpha.txt'), 'alpha\n');

  writeJson(helixPolicyPath, {
    version: '1.0-test',
    enabled: true,
    shadow_only: false,
    codex: {
      codex_path: codexPath,
      key_env: 'HELIX_CODEX_KEY',
      constitution_path: constitutionPath,
      soul_token_state_path: soulStatePath,
      bootstrap_truths: ['preserve_root']
    },
    strands: {
      roots: [fixtureRoot],
      include_ext: ['.txt'],
      exclude_paths: []
    }
  });

  writeJson(admissionPolicyPath, {
    version: '1.0-test',
    enabled: true,
    shadow_only: false,
    require_doctor_approval_for_apply: true,
    require_codex_root_for_apply: true,
    manifest_update_on_apply: true,
    allowed_sources: ['assimilation', 'forge', 'doctor'],
    paths: {
      admissions_path: path.join(stateDir, 'admissions.jsonl'),
      latest_path: path.join(stateDir, 'admission_latest.json'),
      manifest_path: path.join(stateDir, 'manifest.json')
    },
    helix: {
      policy_path: helixPolicyPath,
      codex_path: codexPath
    }
  });

  const env = {
    HELIX_CODEX_KEY: 'helix_test_key_material',
    HELIX_POLICY_PATH: helixPolicyPath,
    HELIX_STATE_DIR: stateDir,
    HELIX_ADMISSION_POLICY_PATH: admissionPolicyPath
  };

  // Initialize codex + baseline manifest.
  let r = run(HELIX_SCRIPT, ['init'], env);
  assert.strictEqual(r.status, 0, r.stderr || r.stdout || 'helix init should pass');

  r = run(SCRIPT, ['candidate', '--source=assimilation', '--capability-id=cap.alpha', '--risk-class=general'], env);
  assert.strictEqual(r.status, 0, r.stderr || r.stdout || 'candidate should pass');
  let payload = parseJson(r.stdout);
  assert.ok(payload && payload.ok === true, 'candidate payload should be ok');
  const candidate = payload.candidate;
  assert.ok(candidate && candidate.strand_hash, 'candidate should include strand hash');

  r = run(SCRIPT, [
    'admit',
    `--candidate-json=${JSON.stringify(candidate)}`,
    '--apply=1',
    '--doctor-approved=1'
  ], env);
  assert.strictEqual(r.status, 0, r.stderr || r.stdout || 'admit should pass');
  payload = parseJson(r.stdout);
  assert.ok(payload && payload.allowed === true, 'admission should be allowed');
  assert.strictEqual(payload.apply_executed, true, 'admission should execute apply path');
  assert.strictEqual(payload.manifest_updated, true, 'admission should update manifest');

  const tampered = { ...candidate, strand_hash: 'bad_hash' };
  r = run(SCRIPT, [
    'admit',
    `--candidate-json=${JSON.stringify(tampered)}`,
    '--apply=1',
    '--doctor-approved=1'
  ], env);
  assert.notStrictEqual(r.status, 0, 'tampered strand should fail');
  payload = parseJson(r.stdout);
  assert.ok(payload && payload.allowed === false, 'tampered candidate must be denied');
  assert.ok((payload.reason_codes || []).includes('strand_hash_mismatch'));

  console.log('helix_admission_gate.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`helix_admission_gate.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
