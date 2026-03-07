#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'first_run_onboarding_wizard.js');

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

function run(args, env) {
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'first-run-onboard-'));
  const policyPath = path.join(tmp, 'config', 'first_run_onboarding_wizard_policy.json');
  const latestPath = path.join(tmp, 'state', 'ops', 'first_run_onboarding_wizard', 'latest.json');
  const historyPath = path.join(tmp, 'state', 'ops', 'first_run_onboarding_wizard', 'history.jsonl');
  const receiptsPath = path.join(tmp, 'state', 'ops', 'first_run_onboarding_wizard', 'receipts.jsonl');

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    onboarding_disable_env: 'PROTHEUS_ONBOARDING_DISABLE',
    first_win_timeout_ms: 90000,
    profile_detection: {
      low_memory_gb: 8,
      high_memory_gb: 32
    },
    recommendations: {
      low_memory: {
        sockets_profile: 'lite',
        memory_profile: 'compressed',
        model_profile: 'local_small',
        security_profile: 'strict'
      },
      balanced: {
        sockets_profile: 'balanced',
        memory_profile: 'standard',
        model_profile: 'hybrid',
        security_profile: 'strict'
      },
      high_capacity: {
        sockets_profile: 'throughput',
        memory_profile: 'expanded',
        model_profile: 'local_deep',
        security_profile: 'strict'
      }
    },
    paths: {
      latest_path: latestPath,
      history_path: historyPath,
      receipts_path: receiptsPath
    }
  });

  let out = run(['run', '--apply=1', '--host-profile=balanced', `--policy=${policyPath}`], {
    FIRST_RUN_ONBOARDING_ROOT: tmp,
    FIRST_RUN_ONBOARDING_POLICY_PATH: policyPath,
    SCI_LOOP_ROOT: tmp
  });
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.type === 'first_run_onboarding_wizard', 'expected onboarding payload');
  assert.strictEqual(out.payload.ok, true, 'expected successful onboarding');
  assert.strictEqual(out.payload.first_win_within_sla, true, 'first win should be within SLA');
  assert.ok(out.payload.recommendations && out.payload.recommendations.model_profile, 'recommendations missing');

  out = run(['status', `--policy=${policyPath}`], {
    FIRST_RUN_ONBOARDING_ROOT: tmp,
    FIRST_RUN_ONBOARDING_POLICY_PATH: policyPath
  });
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.ok === true, 'status should succeed');

  out = run(['run', `--policy=${policyPath}`], {
    FIRST_RUN_ONBOARDING_ROOT: tmp,
    FIRST_RUN_ONBOARDING_POLICY_PATH: policyPath,
    PROTHEUS_ONBOARDING_DISABLE: '1'
  });
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.strictEqual(out.payload.result, 'onboarding_disabled_fallback', 'disable flag should trigger fallback');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('first_run_onboarding_wizard.test.js: OK');
} catch (err) {
  console.error(`first_run_onboarding_wizard.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
