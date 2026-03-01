#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'security', 'venom_containment_layer.js');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function run(args) {
  const r = spawnSync('node', [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  let payload = null;
  try { payload = JSON.parse(String(r.stdout || '').trim()); } catch {}
  return {
    status: r.status == null ? 1 : r.status,
    payload,
    stderr: String(r.stderr || '')
  };
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'venom-layer-'));
  const policyPath = path.join(tmp, 'config', 'venom_containment_policy.json');

  const stateRoot = path.join(tmp, 'state', 'security', 'venom_containment');
  const startupAttPath = path.join(tmp, 'state', 'security', 'startup_attestation.json');
  const soulPath = path.join(tmp, 'state', 'security', 'soul_token_guard.json');
  const leasePath = path.join(tmp, 'state', 'security', 'capability_leases.json');
  const masterQueue = path.join(tmp, 'state', 'workflow', 'learning_conduit', 'master_training_queue.jsonl');
  const adaptiveCostPath = path.join(tmp, 'state', 'security', 'red_team', 'adaptive_defense', 'cost_profiles.json');

  writeJson(startupAttPath, {
    type: 'startup_attestation',
    signature: 'sig_ok',
    expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
  });
  writeJson(soulPath, {
    fingerprint: 'fp_test_1',
    token: 'soul_test_1'
  });
  writeJson(leasePath, {
    active: []
  });
  writeJson(path.join(stateRoot, 'profiles.json'), {
    schema_version: '1.0',
    updated_at: new Date().toISOString(),
    runtime_bias: {
      unknown: 1,
      desktop: 1.05,
      cloud_vm: 1.2,
      gpu_heavy: 1.65,
      containerized: 1.15
    },
    last_uplift: 0.42
  });
  writeJson(adaptiveCostPath, {
    schema_version: '1.0',
    updated_at: new Date().toISOString(),
    fingerprint_profiles: {
      unknown: { challenge_multiplier: 1, friction_multiplier: 1, decoy_intensity: 1, rate_limit_per_minute: 40 },
      desktop: { challenge_multiplier: 1.05, friction_multiplier: 1.1, decoy_intensity: 1.05, rate_limit_per_minute: 36 },
      cloud_vm: { challenge_multiplier: 1.15, friction_multiplier: 1.2, decoy_intensity: 1.1, rate_limit_per_minute: 30 },
      gpu_heavy: { challenge_multiplier: 1.5, friction_multiplier: 1.65, decoy_intensity: 1.45, rate_limit_per_minute: 24 },
      containerized: { challenge_multiplier: 1.1, friction_multiplier: 1.2, decoy_intensity: 1.1, rate_limit_per_minute: 32 }
    },
    last_uplift: 0.5
  });

  writeJson(policyPath, {
    version: '1.0',
    enabled: true,
    shadow_only: true,
    defensive_only_invariant: true,
    timed_lease: {
      stealth_window_enabled: false,
      stealth_window_hours: 0,
      high_value_bypass: true
    },
    staged_ramp: {
      tease_actions: 2,
      challenge_actions: 3,
      degrade_actions: 5,
      lockout_actions: 7,
      lockout_cooldown_minutes: 10
    },
    decoy: {
      distillation_guard: {
        enabled: true,
        noise_token_count: 4,
        contradiction_markers: true,
        max_extra_chars: 180
      }
    },
    enforcement: {
      challenge_threshold: 0.45,
      min_challenge_difficulty_bits: 8,
      max_challenge_difficulty_bits: 14,
      challenge_ttl_seconds: 120,
      challenge_stages: ['challenge', 'degrade', 'lockout'],
      decoy_from_stage: 'challenge'
    },
    adaptive_integration: {
      enabled: true,
      runtime_bias_weight: 1,
      cost_profiles_path: adaptiveCostPath
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
    },
    forensics: {
      enabled: true,
      include_watermark: true,
      master_conduit_mirror: true,
      evidence_dir: path.join(stateRoot, 'evidence'),
      events_path: path.join(stateRoot, 'forensic_events.jsonl')
    }
  });

  let res = run(['evaluate', `--policy=${policyPath}`, '--session-id=auth_ok', '--source=local', '--action=run', '--risk=low']);
  assert.strictEqual(res.status, 0, `authorized evaluate should pass: ${res.stderr}`);
  assert.ok(res.payload && res.payload.ok === true, 'payload should be ok');
  assert.strictEqual(res.payload.unauthorized, false, 'authorized run should not be unauthorized');
  assert.strictEqual(String(res.payload.stage || ''), 'none', 'authorized run should be at stage none');

  const stages = [];
  let sawChallengeRequirement = false;
  for (let i = 0; i < 8; i += 1) {
    res = run([
      'evaluate',
      `--policy=${policyPath}`,
      '--session-id=bad_copy_1',
      '--source=webhook',
      '--action=deploy',
      '--risk=high',
      '--runtime-class=gpu_heavy',
      '--unauthorized=1'
    ]);
    assert.strictEqual(res.status, 0, `unauthorized evaluate run ${i} should pass: ${res.stderr}`);
    assert.ok(res.payload && res.payload.ok === true, 'unauthorized payload should be ok');
    stages.push(String(res.payload.stage || ''));
    if (res.payload && res.payload.verification_challenge && res.payload.verification_challenge.required === true) {
      sawChallengeRequirement = true;
      assert.ok(String(res.payload.verification_challenge.nonce || '').startsWith('vc_'), 'challenge should include nonce');
      assert.ok(Number(res.payload.verification_challenge.difficulty_bits || 0) >= 8, 'challenge difficulty should be configured');
    }
    if (i === 0) {
      assert.ok(
        String(res.payload.decoy_response || '').includes('guard_noise='),
        'decoy response should include bounded distillation guard noise markers'
      );
    }
  }

  assert.ok(stages.includes('tease'), 'stages should include tease');
  assert.ok(stages.includes('challenge'), 'stages should include challenge');
  assert.ok(stages.includes('degrade') || stages.includes('lockout'), 'stages should degrade/lockout');
  assert.strictEqual(stages[stages.length - 1], 'lockout', 'final stage should reach lockout');
  assert.strictEqual(sawChallengeRequirement, true, 'challenge requirement should appear in challenge/degrade/lockout');

  const desktopAdaptive = run([
    'evaluate',
    `--policy=${policyPath}`,
    '--session-id=adaptive_desktop_1',
    '--source=webhook',
    '--action=run',
    '--risk=medium',
    '--runtime-class=desktop',
    '--unauthorized=1'
  ]);
  const gpuAdaptive = run([
    'evaluate',
    `--policy=${policyPath}`,
    '--session-id=adaptive_gpu_1',
    '--source=webhook',
    '--action=run',
    '--risk=medium',
    '--runtime-class=gpu_heavy',
    '--unauthorized=1'
  ]);
  assert.strictEqual(desktopAdaptive.status, 0, 'desktop adaptive run should pass');
  assert.strictEqual(gpuAdaptive.status, 0, 'gpu adaptive run should pass');
  assert.ok(
    Number(gpuAdaptive.payload.friction_delay_ms || 0) > Number(desktopAdaptive.payload.friction_delay_ms || 0),
    'gpu adaptive profile should increase friction over desktop profile'
  );
  assert.ok(
    Number(gpuAdaptive.payload.challenge_score || 0) > Number(desktopAdaptive.payload.challenge_score || 0),
    'gpu adaptive profile should increase challenge score over desktop profile'
  );

  const forensicEventsPath = path.join(stateRoot, 'forensic_events.jsonl');
  assert.ok(fs.existsSync(forensicEventsPath), 'forensic events file must exist');
  const forensicRows = String(fs.readFileSync(forensicEventsPath, 'utf8') || '').split('\n').filter(Boolean);
  assert.ok(forensicRows.length >= 1, 'forensic events should be written');

  assert.ok(fs.existsSync(masterQueue), 'master queue mirror should exist');
  const mqRows = String(fs.readFileSync(masterQueue, 'utf8') || '').split('\n').filter(Boolean);
  assert.ok(mqRows.length >= 1, 'master queue should receive mirrored events');

  const stealthPolicyPath = path.join(tmp, 'config', 'venom_containment_policy_stealth.json');
  writeJson(stealthPolicyPath, {
    version: '1.0',
    enabled: true,
    shadow_only: true,
    defensive_only_invariant: true,
    timed_lease: {
      stealth_window_enabled: true,
      stealth_window_hours: 48,
      high_value_bypass: false
    },
    staged_ramp: {
      tease_actions: 2,
      challenge_actions: 3,
      degrade_actions: 5,
      lockout_actions: 7,
      lockout_cooldown_minutes: 10
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
    },
    forensics: {
      enabled: true,
      include_watermark: true,
      master_conduit_mirror: true,
      evidence_dir: path.join(stateRoot, 'evidence'),
      events_path: path.join(stateRoot, 'forensic_events.jsonl')
    }
  });

  res = run([
    'evaluate',
    `--policy=${stealthPolicyPath}`,
    '--session-id=stealth_copy_1',
    '--source=webhook',
    '--action=run',
    '--risk=low',
    '--runtime-class=desktop',
    '--unauthorized=1'
  ]);
  assert.strictEqual(res.status, 0, `stealth-window evaluate should pass: ${res.stderr}`);
  assert.ok(res.payload && res.payload.ok === true, 'stealth-window payload should be ok');
  assert.strictEqual(res.payload.unauthorized, true, 'stealth-window run should be unauthorized');
  assert.strictEqual(res.payload.timed_lease_stealth_active, true, 'stealth window should be active');
  assert.ok(res.payload.timed_lease_stealth_until_ts, 'stealth window should expose expiry timestamp');
  assert.strictEqual(Number(res.payload.unauthorized_hits || 0), 0, 'stealth window should defer staged hit escalation');

  res = run(['evolve', `--policy=${policyPath}`]);
  assert.strictEqual(res.status, 0, `evolve should pass: ${res.stderr}`);
  assert.ok(res.payload && res.payload.ok === true, 'evolve payload should be ok');

  res = run(['status', `--policy=${policyPath}`]);
  assert.strictEqual(res.status, 0, `status should pass: ${res.stderr}`);
  assert.ok(res.payload && res.payload.ok === true, 'status payload should be ok');
  assert.ok(Number(res.payload.active_lockouts || 0) >= 1, 'status should report active lockout');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('venom_containment_layer.test.js: OK');
} catch (err) {
  console.error(`venom_containment_layer.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
