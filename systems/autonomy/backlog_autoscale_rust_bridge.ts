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

function runViaRustBinaryInversion(payloadBase64: string) {
  for (const candidate of binaryCandidates()) {
    try {
      if (!fs.existsSync(candidate)) continue;
      const out = spawnSync(candidate, ['inversion', `--payload-base64=${payloadBase64}`], {
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

function runViaCargoInversion(payloadBase64: string) {
  const args = [
    'run',
    '--quiet',
    '--manifest-path',
    MANIFEST,
    '--bin',
    'execution_core',
    '--',
    'inversion',
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
    default_backlog_autoscale_state: 'default_backlog_autoscale_state_input',
    normalize_backlog_autoscale_state: 'normalize_backlog_autoscale_state_input',
    spawn_allocated_cells: 'spawn_allocated_cells_input',
    spawn_capacity_boost_snapshot: 'spawn_capacity_boost_snapshot_input',
    inversion_maturity_score: 'inversion_maturity_score_input',
    plan: 'plan_input',
    batch_max: 'batch_input',
    dynamic_caps: 'dynamic_caps_input',
    token_usage: 'token_usage_input',
    normalize_queue: 'normalize_queue_input',
    criteria_gate: 'criteria_gate_input',
    structural_preview_criteria_failure: 'structural_preview_criteria_failure_input',
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
    exec_window_match: 'exec_window_match_input',
    start_of_next_utc_day: 'start_of_next_utc_day_input',
    iso_after_minutes: 'iso_after_minutes_input',
    execute_confidence_history_match: 'execute_confidence_history_match_input',
    execute_confidence_cooldown_key: 'execute_confidence_cooldown_key_input',
    qos_lane_weights: 'qos_lane_weights_input',
    proposal_outcome_status: 'proposal_outcome_status_input',
    queue_underflow_backfill: 'queue_underflow_backfill_input',
    proposal_risk_score: 'proposal_risk_score_input',
    proposal_score: 'proposal_score_input',
    proposal_admission_preview: 'proposal_admission_preview_input',
    impact_weight: 'impact_weight_input',
    risk_penalty: 'risk_penalty_input',
    estimate_tokens: 'estimate_tokens_input',
    proposal_remediation_depth: 'proposal_remediation_depth_input',
    proposal_dedup_key: 'proposal_dedup_key_input',
    proposal_semantic_fingerprint: 'proposal_semantic_fingerprint_input',
    semantic_token_similarity: 'semantic_token_similarity_input',
    semantic_context_comparable: 'semantic_context_comparable_input',
    semantic_near_duplicate_match: 'semantic_near_duplicate_match_input',
    expected_value_signal: 'expected_value_signal_input',
    budget_pacing_gate: 'budget_pacing_gate_input',
    capability_cap: 'capability_cap_input',
    strategy_rank_score: 'strategy_rank_score_input',
    strategy_rank_adjusted: 'strategy_rank_adjusted_input',
    trit_shadow_rank_score: 'trit_shadow_rank_score_input',
    strategy_circuit_cooldown: 'strategy_circuit_cooldown_input',
    strategy_trit_shadow_adjusted: 'strategy_trit_shadow_adjusted_input',
    non_yield_penalty_score: 'non_yield_penalty_score_input',
    collective_shadow_adjustments: 'collective_shadow_adjustments_input',
    strategy_trit_shadow_ranking_summary: 'strategy_trit_shadow_ranking_summary_input',
    shadow_scope_matches: 'shadow_scope_matches_input',
    collective_shadow_aggregate: 'collective_shadow_aggregate_input',
    value_signal_score: 'value_signal_score_input',
    composite_eligibility_score: 'composite_eligibility_score_input',
    time_to_value_score: 'time_to_value_score_input',
    value_density_score: 'value_density_score_input',
    normalize_directive_tier: 'normalize_directive_tier_input',
    directive_tier_weight: 'directive_tier_weight_input',
    directive_tier_min_share: 'directive_tier_min_share_input',
    directive_tier_coverage_bonus: 'directive_tier_coverage_bonus_input',
    directive_tier_reservation_need: 'directive_tier_reservation_need_input',
    pulse_objective_cooldown_active: 'pulse_objective_cooldown_active_input',
    directive_token_hits: 'directive_token_hits_input',
    to_stem: 'to_stem_input',
    normalize_directive_text: 'normalize_directive_text_input',
    tokenize_directive_text: 'tokenize_directive_text_input',
    normalize_spaces: 'normalize_spaces_input',
    parse_lower_list: 'parse_lower_list_input',
    canary_failed_checks_allowed: 'canary_failed_checks_allowed_input',
    proposal_text_blob: 'proposal_text_blob_input',
    percent_mentions_from_text: 'percent_mentions_from_text_input',
    optimization_min_delta_percent: 'optimization_min_delta_percent_input',
    source_eye_ref: 'source_eye_ref_input',
    normalized_risk: 'normalized_risk_input',
    parse_iso_ts: 'parse_iso_ts_input',
    extract_objective_id_token: 'extract_objective_id_token_input',
    normalize_value_currency_token: 'normalize_value_currency_token_input',
    list_value_currencies: 'list_value_currencies_input',
    infer_value_currencies_from_directive_bits: 'infer_value_currencies_from_directive_bits_input',
    has_linked_objective_entry: 'has_linked_objective_entry_input',
    verified_entry_outcome: 'verified_entry_outcome_input',
    verified_revenue_action: 'verified_revenue_action_input',
    minutes_until_next_utc_day: 'minutes_until_next_utc_day_input',
    age_hours: 'age_hours_input',
    url_domain: 'url_domain_input',
    domain_allowed: 'domain_allowed_input',
    is_execute_mode: 'is_execute_mode_input',
    execution_allowed_by_feature_flag: 'execution_allowed_by_feature_flag_input',
    is_tier1_objective_id: 'is_tier1_objective_id_input',
    is_tier1_candidate_objective: 'is_tier1_candidate_objective_input',
    needs_execution_quota: 'needs_execution_quota_input',
    normalize_criteria_metric: 'normalize_criteria_metric_input',
    escape_reg_exp: 'escape_reg_exp_input',
    tool_token_mentioned: 'tool_token_mentioned_input',
    policy_hold_reason_from_event: 'policy_hold_reason_from_event_input',
    strategy_marker_tokens: 'strategy_marker_tokens_input',
    capability_cooldown_key: 'capability_cooldown_key_input',
    readiness_retry_cooldown_key: 'readiness_retry_cooldown_key_input',
    source_eye_id: 'source_eye_id_input',
    deprioritized_source_proposal: 'deprioritized_source_proposal_input',
    composite_eligibility_min: 'composite_eligibility_min_input',
    clamp_threshold: 'clamp_threshold_input',
    applied_thresholds: 'applied_thresholds_input',
    extract_eye_from_evidence_ref: 'extract_eye_from_evidence_ref_input',
    total_outcomes: 'total_outcomes_input',
    derive_entity_bias: 'derive_entity_bias_input',
    build_overlay: 'build_overlay_input',
    has_adaptive_mutation_signal: 'has_adaptive_mutation_signal_input',
    adaptive_mutation_execution_guard: 'adaptive_mutation_execution_guard_input',
    strategy_selection: 'strategy_selection_input',
    calibration_deltas: 'calibration_deltas_input',
    strategy_admission_decision: 'strategy_admission_decision_input',
    expected_value_score: 'expected_value_score_input',
    suggest_run_batch_max: 'suggest_run_batch_max_input',
    backlog_autoscale_snapshot: 'backlog_autoscale_snapshot_input',
    admission_summary: 'admission_summary_input',
    unknown_type_quarantine_decision: 'unknown_type_quarantine_decision_input',
    infer_optimization_delta: 'infer_optimization_delta_input',
    optimization_intent_proposal: 'optimization_intent_proposal_input',
    unlinked_optimization_admission: 'unlinked_optimization_admission_input',
    optimization_good_enough: 'optimization_good_enough_input',
    proposal_dependency_summary: 'proposal_dependency_summary_input',
    choose_selection_mode: 'choose_selection_mode_input',
    explore_quota_for_day: 'explore_quota_for_day_input',
    medium_risk_thresholds: 'medium_risk_thresholds_input',
    medium_risk_gate_decision: 'medium_risk_gate_decision_input',
    route_block_prefilter: 'route_block_prefilter_input',
    manual_gate_prefilter: 'manual_gate_prefilter_input',
    execute_confidence_cooldown_active: 'execute_confidence_cooldown_active_input',
    top_biases_summary: 'top_biases_summary_input',
    criteria_pattern_penalty: 'criteria_pattern_penalty_input',
    strategy_threshold_overrides: 'strategy_threshold_overrides_input',
    effective_allowed_risks: 'effective_allowed_risks_input',
    directive_pulse_stats: 'directive_pulse_stats_input',
    compile_directive_pulse_objectives: 'compile_directive_pulse_objectives_input',
    directive_pulse_objectives_profile: 'directive_pulse_objectives_profile_input',
    recent_directive_pulse_cooldown_count: 'recent_directive_pulse_cooldown_count_input',
    proposal_directive_text: 'proposal_directive_text_input',
    objective_ids_from_pulse_context: 'objective_ids_from_pulse_context_input',
    policy_hold_objective_context: 'policy_hold_objective_context_input',
    proposal_semantic_objective_id: 'proposal_semantic_objective_id_input',
    criteria_pattern_keys: 'criteria_pattern_keys_input',
    success_criteria_requirement: 'success_criteria_requirement_input',
    success_criteria_policy_for_proposal: 'success_criteria_policy_for_proposal_input',
    capability_descriptor: 'capability_descriptor_input',
    normalize_token_usage_shape: 'normalize_token_usage_shape_input',
    directive_pulse_context: 'directive_pulse_context_input',
    is_directive_clarification_proposal: 'is_directive_clarification_proposal_input',
    is_directive_decomposition_proposal: 'is_directive_decomposition_proposal_input',
    sanitize_directive_objective_id: 'sanitize_directive_objective_id_input',
    sanitized_directive_id_list: 'sanitized_directive_id_list_input',
    parse_first_json_line: 'parse_first_json_line_input',
    parse_json_objects_from_text: 'parse_json_objects_from_text_input',
    read_path_value: 'read_path_value_input',
    parse_directive_file_arg: 'parse_directive_file_arg_input',
    parse_directive_objective_arg: 'parse_directive_objective_arg_input',
    parse_objective_id_from_evidence_refs: 'parse_objective_id_from_evidence_refs_input',
    parse_objective_id_from_command: 'parse_objective_id_from_command_input',
    objective_id_for_execution: 'objective_id_for_execution_input',
    short_text: 'short_text_input',
    normalized_signal_status: 'normalized_signal_status_input',
    execution_reserve_snapshot: 'execution_reserve_snapshot_input',
    qos_lane_share_cap_exceeded: 'qos_lane_share_cap_exceeded_input',
    qos_lane_from_candidate: 'qos_lane_from_candidate_input',
    estimate_tokens_for_candidate: 'estimate_tokens_for_candidate_input',
    route_execution_policy_hold: 'route_execution_policy_hold_input',
    policy_hold_pressure: 'policy_hold_pressure_input',
    policy_hold_pattern: 'policy_hold_pattern_input',
    policy_hold_latest_event: 'policy_hold_latest_event_input',
    policy_hold_cooldown: 'policy_hold_cooldown_input',
    policy_hold_run_event: 'policy_hold_run_event_input',
    dod_evidence_diff: 'dod_evidence_diff_input',
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

function runInversionPrimitive(mode: string, data: AnyObj = {}, opts: AnyObj = {}) {
  const normalizedMode = cleanText(mode || '', 80).toLowerCase();
  if (!normalizedMode) return { ok: false, error: 'inversion_mode_missing' };
  const fieldByMode: AnyObj = {
    normalize_impact: 'normalize_impact_input',
    normalize_mode: 'normalize_mode_input',
    normalize_target: 'normalize_target_input',
    normalize_result: 'normalize_result_input',
    objective_id_valid: 'objective_id_valid_input',
    trit_vector_from_input: 'trit_vector_from_input_input',
    jaccard_similarity: 'jaccard_similarity_input',
    trit_similarity: 'trit_similarity_input',
    certainty_threshold: 'certainty_threshold_input',
    max_target_rank: 'max_target_rank_input'
  };
  const field = fieldByMode[normalizedMode];
  if (!field) return { ok: false, error: `inversion_mode_unsupported:${normalizedMode}` };
  const request: AnyObj = { mode: normalizedMode };
  request[field] = data && typeof data === 'object' ? data : {};
  const payloadBase64 = Buffer.from(JSON.stringify(request), 'utf8').toString('base64');

  const bin = runViaRustBinaryInversion(payloadBase64);
  if (bin.ok) return bin;
  if (opts.allow_cli_fallback === false) return bin;
  return runViaCargoInversion(payloadBase64);
}

module.exports = {
  runBacklogAutoscalePrimitive,
  runViaRustBinary,
  runViaCargo,
  runInversionPrimitive,
  runViaRustBinaryInversion,
  runViaCargoInversion
};
