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
    'formal_invariant_engine:merge_guard_hook',
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
    'self_hosted_bootstrap:merge_guard_hook',
    'self_hosted_bootstrap:verify_commands_present',
    'self_hosted_bootstrap:approval_gate_present',
    'workflow:effect_type_gate_hook',
    'helix:safety_resilience_hook'
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
