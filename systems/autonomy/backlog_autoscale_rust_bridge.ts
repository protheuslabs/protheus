#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const MANIFEST = path.join(ROOT, 'crates', 'execution', 'Cargo.toml');

type AnyObj = Record<string, any>;

function cleanText(v: unknown, maxLen = 260) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function parseJsonPayload(raw: unknown) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function binaryCandidates() {
  const explicit = cleanText(process.env.PROTHEUS_EXECUTION_RUST_BIN || '', 500);
  const out = [
    explicit,
    path.join(ROOT, 'target', 'release', 'execution_core'),
    path.join(ROOT, 'target', 'debug', 'execution_core'),
    path.join(ROOT, 'crates', 'execution', 'target', 'release', 'execution_core'),
    path.join(ROOT, 'crates', 'execution', 'target', 'debug', 'execution_core')
  ].filter(Boolean);
  return Array.from(new Set(out));
}

function runViaRustBinary(payloadBase64: string) {
  for (const candidate of binaryCandidates()) {
    try {
      if (!fs.existsSync(candidate)) continue;
      const out = spawnSync(candidate, ['autoscale', `--payload-base64=${payloadBase64}`], {
        cwd: ROOT,
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024
      });
      const payload = parseJsonPayload(out.stdout);
      if (out.status === 0 && payload && typeof payload === 'object') {
        return { ok: true, engine: 'rust_bin', binary_path: candidate, payload };
      }
    } catch {
      // continue
    }
  }
  return { ok: false, error: 'rust_binary_unavailable' };
}

function runViaCargo(payloadBase64: string) {
  const args = [
    'run',
    '--quiet',
    '--manifest-path',
    MANIFEST,
    '--bin',
    'execution_core',
    '--',
    'autoscale',
    `--payload-base64=${payloadBase64}`
  ];
  const out = spawnSync('cargo', args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024
  });
  const payload = parseJsonPayload(out.stdout);
  if (Number(out.status) === 0 && payload && typeof payload === 'object') {
    return { ok: true, engine: 'rust_cargo', payload };
  }
  return {
    ok: false,
    error: `cargo_run_failed:${cleanText(out.stderr || out.stdout || '', 260)}`
  };
}

function runBacklogAutoscalePrimitive(mode: string, data: AnyObj = {}, opts: AnyObj = {}) {
  const normalizedMode = cleanText(mode || '', 80).toLowerCase();
  if (!normalizedMode) return { ok: false, error: 'autoscale_mode_missing' };

  const fieldByMode: AnyObj = {
    plan: 'plan_input',
    batch_max: 'batch_input',
    dynamic_caps: 'dynamic_caps_input',
    token_usage: 'token_usage_input',
    normalize_queue: 'normalize_queue_input',
    criteria_gate: 'criteria_gate_input',
    policy_hold: 'policy_hold_input',
    policy_hold_result: 'policy_hold_result_input',
    no_progress_result: 'no_progress_result_input',
    attempt_run_event: 'attempt_run_event_input',
    safety_stop_run_event: 'safety_stop_run_event_input',
    non_yield_category: 'non_yield_category_input',
    non_yield_reason: 'non_yield_reason_input',
    proposal_type_from_run_event: 'proposal_type_from_run_event_input',
    run_event_objective_id: 'run_event_objective_id_input',
    run_event_proposal_id: 'run_event_proposal_id_input',
    capacity_counted_attempt_event: 'capacity_counted_attempt_event_input',
    repeat_gate_anchor: 'repeat_gate_anchor_input',
    score_only_result: 'score_only_result_input',
    score_only_failure_like: 'score_only_failure_like_input',
    gate_exhausted_attempt: 'gate_exhausted_attempt_input',
    consecutive_gate_exhausted_attempts: 'consecutive_gate_exhausted_attempts_input',
    runs_since_reset_index: 'runs_since_reset_index_input',
    attempt_event_indices: 'attempt_event_indices_input',
    capacity_counted_attempt_indices: 'capacity_counted_attempt_indices_input',
    consecutive_no_progress_runs: 'consecutive_no_progress_runs_input',
    shipped_count: 'shipped_count_input',
    executed_count_by_risk: 'executed_count_by_risk_input',
    run_result_tally: 'run_result_tally_input',
    qos_lane_usage: 'qos_lane_usage_input',
    eye_outcome_count_window: 'eye_outcome_count_window_input',
    eye_outcome_count_last_hours: 'eye_outcome_count_last_hours_input',
    sorted_counts: 'sorted_counts_input',
    normalize_proposal_status: 'normalize_proposal_status_input',
    proposal_status: 'proposal_status_input',
    proposal_status_for_queue_pressure: 'proposal_status_for_queue_pressure_input',
    minutes_since_ts: 'minutes_since_ts_input',
    date_window: 'date_window_input',
    in_window: 'in_window_input',
    start_of_next_utc_day: 'start_of_next_utc_day_input',
    iso_after_minutes: 'iso_after_minutes_input',
    execute_confidence_history_match: 'execute_confidence_history_match_input',
    qos_lane_weights: 'qos_lane_weights_input',
    proposal_outcome_status: 'proposal_outcome_status_input',
    queue_underflow_backfill: 'queue_underflow_backfill_input',
    proposal_risk_score: 'proposal_risk_score_input',
    composite_eligibility_score: 'composite_eligibility_score_input',
    time_to_value_score: 'time_to_value_score_input',
    value_density_score: 'value_density_score_input',
    execution_reserve_snapshot: 'execution_reserve_snapshot_input',
    route_execution_policy_hold: 'route_execution_policy_hold_input',
    policy_hold_pressure: 'policy_hold_pressure_input',
    policy_hold_pattern: 'policy_hold_pattern_input',
    policy_hold_latest_event: 'policy_hold_latest_event_input',
    policy_hold_cooldown: 'policy_hold_cooldown_input',
    policy_hold_run_event: 'policy_hold_run_event_input',
    receipt_verdict: 'receipt_verdict_input'
  };
  const field = fieldByMode[normalizedMode];
  if (!field) return { ok: false, error: `autoscale_mode_unsupported:${normalizedMode}` };
  const request: AnyObj = { mode: normalizedMode };
  request[field] = data && typeof data === 'object' ? data : {};
  const payloadBase64 = Buffer.from(JSON.stringify(request), 'utf8').toString('base64');

  const bin = runViaRustBinary(payloadBase64);
  if (bin.ok) return bin;
  if (opts.allow_cli_fallback === false) return bin;
  return runViaCargo(payloadBase64);
}

module.exports = {
  runBacklogAutoscalePrimitive,
  runViaRustBinary,
  runViaCargo
};
