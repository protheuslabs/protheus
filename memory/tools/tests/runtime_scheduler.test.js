#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'primitives', 'runtime_scheduler.js');

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function parseJson(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function run(args, env = {}) {
  const proc = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env }
  });
  return {
    status: typeof proc.status === 'number' ? proc.status : 1,
    stdout: String(proc.stdout || ''),
    stderr: String(proc.stderr || '')
  };
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-scheduler-'));
  const policyPath = path.join(tmp, 'policy.json');
  const embodimentPolicyPath = path.join(tmp, 'embodiment_policy.json');
  const surfaceBudgetPolicyPath = path.join(tmp, 'surface_budget_policy.json');
  const backgroundPolicyPath = path.join(tmp, 'background_persistent_agent_runtime_policy.json');
  const dreamWardenPolicyPath = path.join(tmp, 'dream_warden_policy.json');
  const statePath = path.join(tmp, 'state', 'scheduler', 'latest.json');
  const receiptsPath = path.join(tmp, 'state', 'scheduler', 'receipts.jsonl');
  const canonicalDir = path.join(tmp, 'state', 'runtime', 'canonical_events');
  writeJson(policyPath, {
    schema_id: 'runtime_scheduler_policy',
    schema_version: '1.0',
    enabled: true,
    default_mode: 'operational',
    modes: ['operational', 'dream', 'inversion'],
    allowed_transitions: {
      operational: ['operational', 'dream', 'inversion'],
      dream: ['dream', 'operational'],
      inversion: ['inversion', 'operational']
    },
    state_path: statePath,
    receipts_path: receiptsPath
  });
  writeJson(embodimentPolicyPath, {
    schema_id: 'embodiment_layer_policy',
    schema_version: '1.0',
    enabled: true,
    required_contract_fields: ['profile_id', 'capabilities', 'surface_budget', 'capability_envelope', 'runtime_modes'],
    parity_ignore_fields: ['measured_at', 'hardware_fingerprint'],
    profiles: {
      phone: { max_parallel_workflows: 2, inversion_depth_cap: 1, dream_intensity_cap: 1, heavy_lanes_disabled: true, min_surface_budget_score: 0.2 },
      desktop: { max_parallel_workflows: 6, inversion_depth_cap: 3, dream_intensity_cap: 3, heavy_lanes_disabled: false, min_surface_budget_score: 0.35 },
      cluster: { max_parallel_workflows: 24, inversion_depth_cap: 5, dream_intensity_cap: 5, heavy_lanes_disabled: false, min_surface_budget_score: 0.5 }
    },
    latest_path: path.join(tmp, 'state', 'hardware', 'embodiment', 'latest.json'),
    receipts_path: path.join(tmp, 'state', 'hardware', 'embodiment', 'receipts.jsonl')
  });
  writeJson(surfaceBudgetPolicyPath, {
    version: '1.0-test',
    enabled: true,
    strict_default: false,
    apply_default: false,
    min_transition_seconds: 0,
    embodiment_policy_path: embodimentPolicyPath,
    embodiment_snapshot_path: path.join(tmp, 'state', 'hardware', 'embodiment', 'latest.json'),
    runtime_state_path: statePath,
    state_path: path.join(tmp, 'state', 'hardware', 'surface_budget', 'latest.json'),
    receipts_path: path.join(tmp, 'state', 'hardware', 'surface_budget', 'receipts.jsonl'),
    tiers: [
      { id: 'critical', max_score: 0.2, allow_modes: ['operational'], inversion_depth_cap: 0, dream_intensity_cap: 0, right_brain_max_ratio: 0, fractal_breadth_cap: 1, max_parallel_workflows: 1 },
      { id: 'balanced', max_score: 1, allow_modes: ['operational', 'dream', 'inversion'], inversion_depth_cap: 5, dream_intensity_cap: 5, right_brain_max_ratio: 1, fractal_breadth_cap: 8, max_parallel_workflows: 24 }
    ]
  });
  writeJson(backgroundPolicyPath, {
    schema_id: 'background_persistent_agent_runtime_policy',
    schema_version: '1.0-test',
    enabled: true,
    shadow_only: true,
    consume_queue_on_tick: true,
    limits: {
      min_tick_interval_sec: 0,
      max_signals_per_tick: 32,
      max_activations_per_tick: 4
    },
    trigger_thresholds: {
      queue_backlog_min: 2,
      error_rate_min: 0.2,
      stale_age_min_sec: 300
    },
    trigger_task_map: {
      queue_backlog: ['anticipation'],
      error_pressure: ['security_vigilance'],
      stale_runtime: ['dream_consolidation']
    },
    state: {
      state_path: path.join(tmp, 'state', 'autonomy', 'background_persistent_runtime', 'state.json'),
      queue_path: path.join(tmp, 'state', 'autonomy', 'background_persistent_runtime', 'queue.jsonl'),
      latest_path: path.join(tmp, 'state', 'autonomy', 'background_persistent_runtime', 'latest.json'),
      receipts_path: path.join(tmp, 'state', 'autonomy', 'background_persistent_runtime', 'receipts.jsonl')
    }
  });
  writeJson(dreamWardenPolicyPath, {
    version: '1.0-test',
    enabled: true,
    shadow_only: true,
    passive_only: true,
    activation: {
      min_successful_self_improvement_cycles: 0,
      min_symbiosis_score: 0,
      min_hours_between_runs: 0
    },
    thresholds: {
      critical_fail_cases_trigger: 1,
      red_team_fail_rate_trigger: 0.1,
      mirror_hold_rate_trigger: 0.3,
      low_symbiosis_score_trigger: 0.7,
      max_patch_candidates: 4
    },
    signals: {
      collective_shadow_latest_path: path.join(tmp, 'state', 'autonomy', 'collective_shadow', 'latest.json'),
      observer_mirror_latest_path: path.join(tmp, 'state', 'autonomy', 'observer_mirror', 'latest.json'),
      red_team_latest_path: path.join(tmp, 'state', 'security', 'red_team', 'latest.json'),
      symbiosis_latest_path: path.join(tmp, 'state', 'symbiosis', 'coherence', 'latest.json'),
      gated_self_improvement_state_path: path.join(tmp, 'state', 'autonomy', 'gated_self_improvement', 'state.json')
    },
    outputs: {
      latest_path: path.join(tmp, 'state', 'security', 'dream_warden', 'latest.json'),
      history_path: path.join(tmp, 'state', 'security', 'dream_warden', 'history.jsonl'),
      receipts_path: path.join(tmp, 'state', 'security', 'dream_warden', 'receipts.jsonl'),
      patch_proposals_path: path.join(tmp, 'state', 'security', 'dream_warden', 'patch_proposals.jsonl'),
      ide_events_path: path.join(tmp, 'state', 'security', 'dream_warden', 'ide_events.jsonl')
    }
  });
  writeJson(path.join(tmp, 'state', 'autonomy', 'collective_shadow', 'latest.json'), {
    red_team: { runs: 2, fail_cases: 1, critical_fail_cases: 0, fail_rate: 0.1 },
    summary: { avoid: 1, reinforce: 0 }
  });
  writeJson(path.join(tmp, 'state', 'autonomy', 'observer_mirror', 'latest.json'), {
    summary: { rates: { hold_rate: 0.05 } },
    observer: { mood: 'guarded' }
  });
  writeJson(path.join(tmp, 'state', 'security', 'red_team', 'latest.json'), {
    ok: true,
    summary: { fail_rate: 0.1 }
  });
  writeJson(path.join(tmp, 'state', 'symbiosis', 'coherence', 'latest.json'), {
    ok: true,
    coherence_score: 0.8,
    coherence_tier: 'high'
  });
  writeJson(path.join(tmp, 'state', 'autonomy', 'gated_self_improvement', 'state.json'), {
    proposals: {}
  });

  const env = {
    RUNTIME_SCHEDULER_POLICY_PATH: policyPath,
    CANONICAL_EVENT_LOG_DIR: canonicalDir,
    EMBODIMENT_LAYER_POLICY_PATH: embodimentPolicyPath,
    SURFACE_BUDGET_POLICY_PATH: surfaceBudgetPolicyPath,
    BACKGROUND_PERSISTENT_RUNTIME_POLICY_PATH: backgroundPolicyPath,
    DREAM_WARDEN_POLICY_PATH: dreamWardenPolicyPath
  };

  const status1 = run(['status'], env);
  assert.strictEqual(status1.status, 0, status1.stderr || status1.stdout);
  const status1Payload = parseJson(status1.stdout);
  assert.strictEqual(status1Payload.mode, 'operational');
  assert.ok(status1Payload.embodiment && status1Payload.embodiment.profile_id, 'status should include embodiment summary');
  assert.ok(status1Payload.surface_budget && Array.isArray(status1Payload.surface_budget.allow_modes), 'status should include surface budget summary');
  assert.ok(status1Payload.persistent_runtime && status1Payload.persistent_runtime.ok === true, 'status should include persistent runtime summary');
  assert.ok(status1Payload.dream_warden && typeof status1Payload.dream_warden === 'object', 'status should include dream warden summary');

  const triggerPersistent = run([
    'trigger-persistent',
    '--source=runtime_scheduler_test',
    '--context-json={"queue_backlog":6,"error_rate":0.01,"stale_age_sec":10}'
  ], env);
  assert.strictEqual(triggerPersistent.status, 0, triggerPersistent.stderr || triggerPersistent.stdout);
  const triggerPayload = parseJson(triggerPersistent.stdout);
  assert.strictEqual(triggerPayload.ok, true, 'trigger-persistent should pass');
  assert.ok(triggerPayload.tick && Number(triggerPayload.tick.activation_count || 0) >= 1, 'persistent trigger should schedule activation');

  const triggerWarden = run([
    'trigger-dream-warden',
    '2026-02-28',
    '--source=runtime_scheduler_test',
    '--apply=0'
  ], env);
  assert.strictEqual(triggerWarden.status, 0, triggerWarden.stderr || triggerWarden.stdout);
  const triggerWardenPayload = parseJson(triggerWarden.stdout);
  assert.strictEqual(triggerWardenPayload.ok, true, 'trigger-dream-warden should pass');
  assert.ok(triggerWardenPayload.run && triggerWardenPayload.run.ok === true, 'dream warden run payload should be ok');

  const toDream = run(['switch', '--mode=dream', '--reason=test', '--apply=1'], env);
  assert.strictEqual(toDream.status, 0, toDream.stderr || toDream.stdout);
  const toDreamPayload = parseJson(toDream.stdout);
  assert.strictEqual(toDreamPayload.ok, true);
  assert.strictEqual(toDreamPayload.to_mode, 'dream');

  const illegal = run(['switch', '--mode=inversion', '--reason=invalid', '--apply=1'], env);
  assert.notStrictEqual(illegal.status, 0, 'dream->inversion should be blocked by transition policy');
  const illegalPayload = parseJson(illegal.stdout);
  assert.strictEqual(illegalPayload.error, 'transition_not_allowed');

  const back = run(['switch', '--mode=operational', '--reason=back', '--apply=1'], env);
  assert.strictEqual(back.status, 0, back.stderr || back.stdout);

  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.strictEqual(state.mode, 'operational');
  assert.ok(fs.existsSync(receiptsPath), 'scheduler receipts should exist');

  const day = new Date().toISOString().slice(0, 10);
  const canonicalLog = path.join(canonicalDir, `${day}.jsonl`);
  assert.ok(fs.existsSync(canonicalLog), 'scheduler should emit canonical events');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('runtime_scheduler.test.js: OK');
} catch (err) {
  console.error(`runtime_scheduler.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
