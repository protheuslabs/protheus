#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const { runBacklogAutoscalePrimitive } = require(path.join(ROOT, 'systems', 'autonomy', 'backlog_autoscale_rust_bridge.js'));

function fail(msg) {
  console.error(`❌ autonomy_backlog_autoscale_rust_bridge.test.js: ${msg}`);
  process.exit(1);
}

function ensureReleaseBinary() {
  const out = spawnSync('cargo', ['build', '--manifest-path', 'core/layer2/execution/Cargo.toml', '--release'], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  if (Number(out.status) !== 0) {
    fail(`cargo build failed: ${(out.stderr || out.stdout || '').slice(0, 300)}`);
  }
}

function getPayload(result, label) {
  if (!result || result.ok !== true || !result.payload || typeof result.payload !== 'object') {
    fail(`${label}: rust bridge invocation failed: ${JSON.stringify(result || {})}`);
  }
  if (result.payload.ok !== true || !result.payload.payload || typeof result.payload.payload !== 'object') {
    fail(`${label}: invalid bridge payload: ${JSON.stringify(result.payload || {})}`);
  }
  return result.payload.payload;
}

function main() {
  ensureReleaseBinary();

  const planInput = {
    queue_pressure: { pressure: 'critical', pending: 41, pending_ratio: 0.72 },
    min_cells: 0,
    max_cells: 4,
    current_cells: 1,
    run_interval_minutes: 10,
    idle_release_minutes: 120,
    autopause_active: false,
    last_run_minutes_ago: 25,
    last_high_pressure_minutes_ago: 4,
    trit_shadow_blocked: false
  };
  const first = getPayload(runBacklogAutoscalePrimitive('plan', planInput, { allow_cli_fallback: true }), 'plan:first');
  const second = getPayload(runBacklogAutoscalePrimitive('plan', planInput, { allow_cli_fallback: true }), 'plan:second');

  assert.strictEqual(first.action, 'scale_up');
  assert.strictEqual(Number(first.target_cells), 4);
  assert.deepStrictEqual(first, second, 'plan output should be deterministic');

  const batchInput = {
    enabled: true,
    max_batch: 6,
    daily_remaining: 4,
    pressure: 'critical',
    current_cells: 4,
    budget_blocked: true,
    trit_shadow_blocked: false
  };
  const batch = getPayload(runBacklogAutoscalePrimitive('batch_max', batchInput, { allow_cli_fallback: true }), 'batch');
  assert.strictEqual(Number(batch.max), 1);
  assert.strictEqual(batch.reason, 'budget_blocked');

  const dynamicInput = {
    enabled: true,
    base_daily_cap: 6,
    base_canary_cap: 2,
    candidate_pool_size: 30,
    queue_pressure: 'warning',
    policy_hold_level: 'normal',
    policy_hold_applicable: false,
    spawn_boost_enabled: false,
    spawn_boost_active: false,
    shipped_today: 0,
    no_progress_streak: 0,
    gate_exhaustion_streak: 0,
    warn_factor: 0.75,
    critical_factor: 0.5,
    min_input_pool: 8
  };
  const dynamic = getPayload(runBacklogAutoscalePrimitive('dynamic_caps', dynamicInput, { allow_cli_fallback: true }), 'dynamic_caps');
  assert.strictEqual(dynamic.low_yield, true);
  assert.ok(Number(dynamic.daily_runs_cap) < 6);
  assert.ok(Number(dynamic.input_candidates_cap) >= 8);

  const tokenUsage = getPayload(
    runBacklogAutoscalePrimitive(
      'token_usage',
      {
        selected_model_tokens_est: 180,
        route_budget_request_tokens_est: 140,
        route_tokens_est: 120,
        fallback_est_tokens: 100,
        metrics_prompt_tokens: 24,
        metrics_completion_tokens: 16,
        metrics_source: 'route_execute_metrics'
      },
      { allow_cli_fallback: true }
    ),
    'token_usage'
  );
  assert.strictEqual(tokenUsage.available, true);
  assert.strictEqual(Number(tokenUsage.actual_total_tokens), 40);
  assert.strictEqual(Number(tokenUsage.effective_tokens), 40);
  assert.strictEqual(String(tokenUsage.source), 'route_execute_metrics');

  const normalizedQueue = getPayload(
    runBacklogAutoscalePrimitive(
      'normalize_queue',
      {
        pressure: '',
        pending: 90,
        total: 120,
        pending_ratio: null,
        warn_pending_count: 45,
        critical_pending_count: 80,
        warn_pending_ratio: 0.3,
        critical_pending_ratio: 0.45
      },
      { allow_cli_fallback: true }
    ),
    'normalize_queue'
  );
  assert.strictEqual(normalizedQueue.pressure, 'critical');
  assert.strictEqual(Number(normalizedQueue.pending), 90);
  assert.strictEqual(Number(normalizedQueue.total), 120);
  assert.ok(Number(normalizedQueue.pending_ratio) >= 0.7);

  const criteriaGate = getPayload(
    runBacklogAutoscalePrimitive(
      'criteria_gate',
      {
        min_count: 2,
        total_count: 2,
        contract_not_allowed_count: 1,
        unsupported_count: 0,
        structurally_supported_count: 1,
        contract_violation_count: 1
      },
      { allow_cli_fallback: true }
    ),
    'criteria_gate'
  );
  assert.strictEqual(criteriaGate.pass, false);
  assert.ok(Array.isArray(criteriaGate.reasons) && criteriaGate.reasons.includes('criteria_contract_violation'));

  const policyHold = getPayload(
    runBacklogAutoscalePrimitive(
      'policy_hold',
      {
        target: 'route',
        gate_decision: 'ALLOW',
        route_decision: 'ALLOW',
        needs_manual_review: false,
        executable: true,
        budget_reason: 'budget guard blocked',
        route_reason: '',
        budget_blocked_flag: false,
        budget_global_blocked: false,
        budget_enforcement_blocked: false
      },
      { allow_cli_fallback: true }
    ),
    'policy_hold'
  );
  assert.strictEqual(policyHold.hold, true);
  assert.strictEqual(policyHold.hold_scope, 'budget');

  const receiptVerdict = getPayload(
    runBacklogAutoscalePrimitive(
      'receipt_verdict',
      {
        decision: 'ACTUATE',
        exec_ok: false,
        postconditions_ok: true,
        dod_passed: true,
        success_criteria_required: true,
        success_criteria_passed: true,
        queue_outcome_logged: true,
        route_attestation_status: 'ok',
        route_attestation_expected_model: 'gpt-5',
        success_criteria_primary_failure: null
      },
      { allow_cli_fallback: true }
    ),
    'receipt_verdict'
  );
  assert.strictEqual(String(receiptVerdict.exec_check_name), 'actuation_execute_ok');
  assert.strictEqual(String(receiptVerdict.outcome), 'reverted');
  assert.ok(Array.isArray(receiptVerdict.failed) && receiptVerdict.failed.includes('actuation_execute_ok'));

  console.log('autonomy_backlog_autoscale_rust_bridge.test.js: OK');
}

try {
  main();
} catch (err) {
  fail(err && err.message ? err.message : String(err));
}
