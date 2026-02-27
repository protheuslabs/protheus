#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'foundation_contract_gate.js');

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

function main() {
  const run = spawnSync(process.execPath, [SCRIPT, 'run', '--strict=1'], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  assert.strictEqual(run.status, 0, run.stderr || 'foundation contract gate should pass');
  const payload = parseJson(run.stdout);
  assert.ok(payload && payload.ok === true, 'gate payload should be ok');
  assert.ok(Array.isArray(payload.checks) && payload.checks.length > 0, 'checks missing');
  const byId = new Map(payload.checks.map((row) => [row.id, row]));
  for (const id of [
    'catalog:opcode_cap',
    'catalog:adapter_opcode_coverage',
    'catalog:adapter_effect_coverage',
    'catalog:migration_contract_version',
    'catalog:migration_contract_coverage',
    'distill_or_atrophy:active_debt_cap',
    'distill_or_atrophy:total_candidate_cap',
    'scheduler_modes:contains_dream_inversion',
    'profile_compatibility:n_minus_2_minimum',
    'distributed_control_plane:quorum_floor',
    'distributed_control_plane:trust_domain_required',
    'effect_type:policy_enforced',
    'effect_type:forbidden_transition_rules',
    'schema_evolution:n_minus_two_floor',
    'key_lifecycle:post_quantum_track_present',
    'legal:license_terms_present',
    'legal:contribution_terms_present',
    'legal:onboarding_references_present',
    'legal:tos_present',
    'legal:eula_present',
    'legal:terms_ack_policy_present',
    'repo_access:policy_private_visibility',
    'repo_access:policy_least_privilege',
    'repo_access:quarterly_review_cadence',
    'legal:merge_guard_terms_ack_hook',
    'repo_access:merge_guard_hook',
    'repo_access:runbook_present',
    'legal:installer_terms_ack_gate',
    'formal_invariant_engine:merge_guard_hook',
    'critical_path_formal:merge_guard_hook',
    'critical_path_formal:policy_axioms_and_weights',
    'critical_path_formal:policy_high_risk_targets_disabled',
    'critical_path_formal:policy_paths_present',
    'supply_chain_trust_plane:merge_guard_hook',
    'schema_evolution:merge_guard_hook',
    'key_lifecycle:merge_guard_hook',
    'simplicity_budget:merge_guard_hook',
    'simplicity_budget:policy_enabled',
    'simplicity_budget:core_caps_present',
    'causal_temporal_graph:merge_guard_hook',
    'causal_temporal_graph:policy_enabled',
    'causal_temporal_graph:counterfactual_gate_present',
    'emergent_primitive_synthesis:merge_guard_hook',
    'emergent_primitive_synthesis:human_gate_required',
    'emergent_primitive_synthesis:nursery_adversarial_required',
    'hardware_embodiment:merge_guard_hook',
    'hardware_embodiment:required_contract_fields',
    'hardware_embodiment:profile_count_floor',
    'resurrection_protocol:merge_guard_hook',
    'resurrection_protocol:key_env_present',
    'resurrection_protocol:multi_shard_floor',
    'value_anchor_renewal:merge_guard_hook',
    'value_anchor_renewal:shift_threshold_order',
    'value_anchor_renewal:review_gate_enabled',
    'gated_self_improvement:merge_guard_hook',
    'gated_self_improvement:policy_gates_and_stages',
    'gated_self_improvement:controller_hooks',
    'explanation_primitive:merge_guard_hook',
    'explanation_primitive:policy_enabled',
    'explanation_primitive:proof_and_passport_gates',
    'delegated_authority:merge_guard_hook',
    'delegated_authority:constitution_denied_scopes',
    'delegated_authority:key_lifecycle_dependency',
    'world_model_freshness:merge_guard_hook',
    'world_model_freshness:stale_warning_order',
    'world_model_freshness:profile_roots_present',
    'continuous_chaos_resilience:merge_guard_hook',
    'continuous_chaos_resilience:gate_thresholds_valid',
    'continuous_chaos_resilience:cadence_declared',
    'siem_bridge:merge_guard_hook',
    'siem_bridge:correlation_rules_present',
    'siem_bridge:export_and_roundtrip_paths_present',
    'soc2_type2_track:merge_guard_hook',
    'soc2_type2_track:minimum_window_floor',
    'soc2_type2_track:exception_and_bundle_paths_present',
    'predictive_capacity_forecast:merge_guard_hook',
    'predictive_capacity_forecast:horizon_contract',
    'predictive_capacity_forecast:paths_present',
    'execution_sandbox_envelope:merge_guard_hook',
    'execution_sandbox_envelope:policy_profiles',
    'execution_sandbox_envelope:deny_defaults_and_high_risk_gate',
    'organ_state_encryption:merge_guard_hook',
    'organ_state_encryption:rotation_and_fail_closed',
    'organ_state_encryption:lane_roots_present',
    'remote_tamper_heartbeat:merge_guard_hook',
    'remote_tamper_heartbeat:policy_quarantine_and_signature',
    'remote_tamper_heartbeat:paths_present',
    'secure_heartbeat_endpoint:merge_guard_hook',
    'secure_heartbeat_endpoint:policy_auth_and_rate',
    'secure_heartbeat_endpoint:paths_present',
    'secure_heartbeat_endpoint:runbook_hook',
    'helix_admission:merge_guard_hook',
    'helix_admission:policy_sources_and_apply_controls',
    'helix_admission:paths_present',
    'helix_baseline:merge_guard_hook',
    'helix_baseline:policy_shadow_and_reweave_paths',
    'helix_reweave:controller_apply_hook',
    'helix_reweave:doctor_snapshot_apply_hooks',
    'helix_confirmed_malice:merge_guard_hook',
    'helix_confirmed_malice:policy_thresholds',
    'helix_confirmed_malice:paths_present',
    'redteam_ant_colony:merge_guard_hook',
    'redteam_ant_colony:policy_triple_consensus_and_priority_window',
    'redteam_ant_colony:controller_hooks',
    'neural_dormant_seed:merge_guard_hook',
    'neural_dormant_seed:locked_and_blocked',
    'neural_dormant_seed:governance_checklist_depth',
    'pre_neuralink_interface:merge_guard_hook',
    'pre_neuralink_interface:policy_local_first_and_consent',
    'pre_neuralink_interface:route_allowed_states_gate',
    'pre_neuralink_interface:controller_hooks',
    'phone_seed_profile:merge_guard_hook',
    'phone_seed_profile:thresholds_present',
    'phone_seed_profile:heavy_lane_gate',
    'surface_budget_controller:merge_guard_hook',
    'surface_budget_controller:tiers_declared',
    'surface_budget_controller:cadence_gate_present',
    'compression_transfer_plane:merge_guard_hook',
    'compression_transfer_plane:include_paths_present',
    'compression_transfer_plane:bundle_paths_present',
    'opportunistic_offload_plane:merge_guard_hook',
    'opportunistic_offload_plane:thresholds_present',
    'opportunistic_offload_plane:schedule_command_present',
    'client_relationship_manager:merge_guard_hook',
    'client_relationship_manager:event_types_present',
    'client_relationship_manager:manual_target_present',
    'gated_account_creation:merge_guard_hook',
    'gated_account_creation:policy_profile_first_high_risk_gate',
    'gated_account_creation:templates_present',
    'gated_account_creation:controller_hooks',
    'capital_allocation_organ:merge_guard_hook',
    'capital_allocation_organ:buckets_present',
    'capital_allocation_organ:simulation_and_rar_targets',
    'economic_entity_manager:merge_guard_hook',
    'economic_entity_manager:policy_tax_and_human_gates',
    'economic_entity_manager:controller_hooks',
    'drift_aware_revenue_optimizer:merge_guard_hook',
    'drift_aware_revenue_optimizer:drift_cap_present',
    'drift_aware_revenue_optimizer:slo_and_sources_present',
    'self_hosted_bootstrap:merge_guard_hook',
    'self_hosted_bootstrap:verify_commands_present',
    'self_hosted_bootstrap:approval_gate_present',
    'workflow:effect_type_gate_hook',
    'workflow:sandbox_envelope_hook',
    'actuation:sandbox_envelope_hook',
    'helix:safety_resilience_hook',
    'helix:confirmed_malice_quarantine_hook'
  ]) {
    assert.ok(byId.has(id), `missing check: ${id}`);
    assert.strictEqual(byId.get(id).ok, true, `check should pass: ${id}`);
  }
  console.log('foundation_contract_gate.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`foundation_contract_gate.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
