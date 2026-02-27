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

function runCli(scriptPath, args, env, cwd) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd,
    env,
    encoding: 'utf8'
  });
}

function run() {
  const root = path.resolve(__dirname, '..', '..', '..');
  const scriptPath = path.join(root, 'systems', 'ops', 'autotest_recipe_release.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'autotest-recipe-release-'));
  const policyPath = path.join(tmp, 'config', 'autotest_doctor_policy.json');
  const manifestPath = path.join(tmp, 'state', 'ops', 'autotest_doctor', 'recipe_release_manifest.json');

  writeJson(policyPath, {
    version: '1.0-test',
    recipe_release: {
      key_env: 'AUTOTEST_DOCTOR_RECIPE_KEY',
      manifest_path: manifestPath
    },
    recipes: [
      {
        id: 'retest_then_pulse',
        enabled: true,
        applies_to: ['assertion_failed'],
        steps: ['retest_failed_test', 'autotest_run_changed']
      }
    ]
  });

  const env = {
    ...process.env,
    AUTOTEST_DOCTOR_RECIPE_KEY: 'test_recipe_key_123'
  };

  let r = runCli(scriptPath, ['seal', `--policy=${policyPath}`, '--channel=stable', '--release-seq=7'], env, root);
  assert.strictEqual(r.status, 0, `seal should pass: ${r.stderr}`);
  let out = parsePayload(r.stdout);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.release_seq, 7);
  assert.ok(fs.existsSync(manifestPath), 'manifest should exist after seal');

  r = runCli(scriptPath, ['verify', `--policy=${policyPath}`], env, root);
  assert.strictEqual(r.status, 0, `verify should pass: ${r.stderr}`);
  out = parsePayload(r.stdout);
  assert.strictEqual(out.ok, true, 'verify should pass for untampered manifest');
  assert.strictEqual(out.digest_match, true);
  assert.strictEqual(out.signature_valid, true);

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.recipe_digest = 'tampered_digest';
  writeJson(manifestPath, manifest);

  r = runCli(scriptPath, ['verify', `--policy=${policyPath}`], env, root);
  assert.strictEqual(r.status, 1, 'verify should fail after tamper');
  out = parsePayload(r.stdout);
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.digest_match, false);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('autotest_recipe_release.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autotest_recipe_release.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

