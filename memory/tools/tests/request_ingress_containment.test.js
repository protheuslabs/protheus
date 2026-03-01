#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'security', 'request_ingress.js');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function runIngress(env) {
  const start = Date.now();
  const r = spawnSync(
    'node',
    [
      SCRIPT,
      'run',
      '--source=webhook',
      '--action=deploy',
      '--',
      'node',
      '-e',
      "process.stdout.write('REAL_OUTPUT\\n')"
    ],
    {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        ...env
      }
    }
  );
  return {
    status: r.status == null ? 1 : r.status,
    stdout: String(r.stdout || ''),
    stderr: String(r.stderr || ''),
    elapsed_ms: Date.now() - start
  };
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'request-ingress-containment-'));
  const policyPath = path.join(tmp, 'config', 'venom_containment_policy.json');
  const stateRoot = path.join(tmp, 'state', 'security', 'venom_containment');
  const startupAttPath = path.join(tmp, 'state', 'security', 'startup_attestation.json');
  const soulPath = path.join(tmp, 'state', 'security', 'soul_token_guard.json');
  const leasePath = path.join(tmp, 'state', 'security', 'capability_leases.json');
  const masterQueue = path.join(tmp, 'state', 'workflow', 'learning_conduit', 'master_training_queue.jsonl');

  writeJson(startupAttPath, {
    type: 'startup_attestation',
    signature: 'sig_ok',
    expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
  });
  writeJson(soulPath, {
    fingerprint: 'fp_request_ingress',
    token: 'soul_request_ingress'
  });
  writeJson(leasePath, { active: [] });

  writeJson(policyPath, {
    version: '1.0',
    enabled: true,
    shadow_only: false,
    defensive_only_invariant: true,
    trusted_sources: ['local', 'cli', 'daemon', 'spine'],
    high_value_actions: ['deploy', 'apply'],
    timed_lease: {
      stealth_window_enabled: false,
      stealth_window_hours: 0,
      high_value_bypass: true
    },
    staged_ramp: {
      tease_actions: 1,
      challenge_actions: 2,
      degrade_actions: 3,
      lockout_actions: 5,
      lockout_cooldown_minutes: 10
    },
    bounds: {
      max_friction_delay_ms: 900,
      max_challenge_score: 0.95,
      max_lease_decay_rate: 0.8,
      max_containment_children: 4
    },
    enforcement: {
      challenge_threshold: 0.95,
      min_challenge_difficulty_bits: 8,
      max_challenge_difficulty_bits: 12,
      challenge_ttl_seconds: 120,
      challenge_stages: ['challenge', 'degrade', 'lockout'],
      decoy_from_stage: 'challenge'
    },
    forensics: {
      enabled: true,
      include_watermark: true,
      master_conduit_mirror: true,
      evidence_dir: path.join(stateRoot, 'evidence'),
      events_path: path.join(stateRoot, 'forensic_events.jsonl')
    },
    paths: {
      state_root: stateRoot,
      sessions_path: path.join(stateRoot, 'sessions.json'),
      latest_path: path.join(stateRoot, 'latest.json'),
      history_path: path.join(stateRoot, 'history.jsonl'),
      profiles_path: path.join(stateRoot, 'profiles.json'),
      startup_attestation_path: startupAttPath,
      soul_token_guard_path: soulPath,
      lease_state_path: leasePath,
      master_queue_path: masterQueue
    }
  });

  const commonEnv = {
    VENOM_CONTAINMENT_POLICY_PATH: policyPath,
    REQUEST_GATE_SECRET: 'test_secret',
    REQUEST_NONCE: 'req_ingress_session_1',
    REQUEST_RUNTIME_CLASS: 'cloud_vm'
  };

  const first = runIngress(commonEnv);
  assert.strictEqual(first.status, 0, `first run should pass: ${first.stderr}`);
  assert.ok(first.stdout.includes('REAL_OUTPUT'), 'first run should allow real output during tease stage');

  const second = runIngress(commonEnv);
  assert.strictEqual(second.status, 0, `second run should pass with decoy output: ${second.stderr}`);
  assert.ok(second.stdout.includes('[contained-'), 'second run should return decoy output after challenge stage');
  assert.ok(!second.stdout.includes('REAL_OUTPUT'), 'second run should suppress real output in decoy-only mode');
  assert.ok(second.elapsed_ms >= 500, `second run should enforce bounded delay (elapsed=${second.elapsed_ms}ms)`);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('request_ingress_containment.test.js: OK');
} catch (err) {
  console.error(`request_ingress_containment.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

