#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeJsonl(filePath, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');
}

function parsePayload(stdout) {
  const raw = String(stdout || '').trim();
  assert.ok(raw, 'expected stdout');
  try { return JSON.parse(raw); } catch {}
  const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  throw new Error('unable to parse json payload');
}

function stableStringify(value) {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((row) => stableStringify(row)).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function hmacHex(value, key) {
  return crypto.createHmac('sha256', String(key || '')).update(stableStringify(value)).digest('hex');
}

function recipeDigest(recipes) {
  return crypto.createHash('sha256').update(stableStringify(recipes)).digest('hex');
}

function runCli(scriptPath, args, env, cwd) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd,
    env,
    encoding: 'utf8'
  });
}

function run() {
  const root = path.resolve(__dirname, '..', '..', '..');
  const scriptPath = path.join(root, 'systems', 'ops', 'autotest_doctor.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'autotest-doctor-release-rollout-'));
  const dateStr = '2026-02-27';

  const stateDir = path.join(tmp, 'state', 'ops', 'autotest_doctor');
  const runsDir = path.join(tmp, 'state', 'ops', 'autotest', 'runs');
  const latestPath = path.join(tmp, 'state', 'ops', 'autotest', 'latest.json');
  const statusPath = path.join(tmp, 'state', 'ops', 'autotest', 'status.json');
  const registryPath = path.join(tmp, 'state', 'ops', 'autotest', 'registry.json');
  const policyPath = path.join(tmp, 'config', 'autotest_doctor_policy.json');
  const manifestPath = path.join(stateDir, 'recipe_release_manifest.json');
  const verifierStatePath = path.join(stateDir, 'recipe_verifier_state.json');

  const recipes = [
    {
      id: 'retest_then_pulse',
      enabled: true,
      applies_to: ['assertion_failed', 'exit_nonzero'],
      steps: ['retest_failed_test']
    }
  ];

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    shadow_mode: false,
    sleep_window_local: { enabled: false, start_hour: 0, end_hour: 7 },
    gating: {
      min_consecutive_failures: 1,
      max_actions_per_run: 2,
      cooldown_sec_per_signature: 0,
      max_repairs_per_signature_per_day: 5
    },
    kill_switch: {
      enabled: true,
      window_hours: 24,
      max_unknown_signatures_per_window: 10,
      max_suspicious_signatures_per_window: 10,
      max_repairs_per_window: 50,
      max_rollbacks_per_window: 50,
      max_same_signature_repairs_per_window: 20,
      auto_reset_hours: 0
    },
    execution: { step_timeout_ms: 2000, autotest_max_tests: 1 },
    recipes,
    recipe_release: {
      enabled: true,
      fail_closed: true,
      require_signature: true,
      max_manifest_age_hours: 24,
      key_env: 'AUTOTEST_DOCTOR_RECIPE_KEY',
      manifest_path: manifestPath,
      state_path: path.join(stateDir, 'recipe_release_state.json'),
      allowed_channels: ['stable']
    },
    recipe_rollout: {
      enabled: true,
      default_stage: 'shadow',
      canary_fraction: 1,
      max_canary_actions_per_run: 2,
      min_successes_for_live: 2,
      max_rollbacks_before_demote: 1,
      require_recent_verification: true,
      verification_max_age_hours: 24,
      state_path: path.join(stateDir, 'recipe_rollout_state.json'),
      verifier_state_path: verifierStatePath
    },
    watchdog: {
      enabled: false
    }
  });

  writeJson(verifierStatePath, {
    version: '1.0',
    ts: `${dateStr}T03:00:00.000Z`,
    recipes: {
      retest_then_pulse: {
        verified_at: `${dateStr}T03:00:00.000Z`,
        ok: true,
        sample_count: 1,
        violations: []
      }
    }
  });

  const manifestBase = {
    type: 'autotest_recipe_release_manifest',
    generated_at: `${dateStr}T03:00:00.000Z`,
    policy_version: '1.0-test',
    channel: 'stable',
    release_seq: 1,
    recipe_count: recipes.length,
    recipe_digest: recipeDigest(recipes)
  };
  const key = 'test_recipe_rollout_key';
  writeJson(manifestPath, {
    ...manifestBase,
    signature: hmacHex(manifestBase, key)
  });

  writeJson(latestPath, {
    ok: true,
    ts: `${dateStr}T03:00:00.000Z`,
    failed_tests: 1,
    modules_red: 1,
    modules_changed: 1
  });
  writeJson(statusPath, { modules: {} });
  writeJson(registryPath, { modules: {} });
  writeJsonl(path.join(runsDir, `${dateStr}.jsonl`), [
    {
      type: 'autotest_run',
      ts: `${dateStr}T03:00:00.000Z`,
      results: [
        {
          id: 'tst_release_rollout',
          command: 'node memory/tools/tests/autotest_doctor_release_rollout.test.js',
          guard_ok: true,
          ok: false,
          exit_code: 1,
          stderr_excerpt: 'simulated fail'
        }
      ]
    }
  ]);

  const env = {
    ...process.env,
    AUTOTEST_DOCTOR_STATE_DIR: stateDir,
    AUTOTEST_DOCTOR_AUTOTEST_RUNS_DIR: runsDir,
    AUTOTEST_DOCTOR_AUTOTEST_LATEST_PATH: latestPath,
    AUTOTEST_DOCTOR_AUTOTEST_STATUS_PATH: statusPath,
    AUTOTEST_DOCTOR_AUTOTEST_REGISTRY_PATH: registryPath,
    AUTOTEST_DOCTOR_RECIPE_KEY: key
  };

  let r = runCli(scriptPath, ['run', dateStr, `--policy=${policyPath}`, '--apply=1'], env, root);
  assert.strictEqual(r.status, 0, `doctor apply run should pass: ${r.stderr}`);
  let out = parsePayload(r.stdout);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.apply, true, 'apply should remain enabled');
  assert.strictEqual(out.recipe_release_gate && out.recipe_release_gate.valid, true, 'recipe release gate should validate');
  assert.strictEqual(Number(out.actions_applied || 0), 1, 'verified canary recipe should execute');

  const tamperedManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  tamperedManifest.recipe_digest = 'tampered_digest';
  writeJson(manifestPath, tamperedManifest);

  r = runCli(scriptPath, ['run', dateStr, `--policy=${policyPath}`, '--apply=1'], env, root);
  assert.strictEqual(r.status, 0, `doctor run should still return payload on gate failure: ${r.stderr}`);
  out = parsePayload(r.stdout);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.skipped, true, 'tampered manifest should force skip in apply mode');
  assert.ok(Array.isArray(out.skip_reasons) && out.skip_reasons.includes('recipe_release_gate_failed'), 'skip reason should include release gate');
  assert.strictEqual(Number(out.actions_applied || 0), 0, 'tampered release gate should block apply');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('autotest_doctor_release_rollout.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autotest_doctor_release_rollout.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

