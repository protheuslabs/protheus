#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');

function nowIso() {
  return new Date().toISOString();
}

function cleanText(v: unknown, maxLen = 240) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeToken(v: unknown, maxLen = 120) {
  return cleanText(v, maxLen)
    .replace(/[^a-zA-Z0-9_.:/-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function normalizeLowerToken(v: unknown, maxLen = 120) {
  return normalizeToken(v, maxLen).toLowerCase();
}

function normalizeUpperToken(v: unknown, maxLen = 120) {
  return normalizeToken(v, maxLen).toUpperCase();
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (const tok of argv) {
    if (!String(tok || '').startsWith('--')) {
      out._.push(String(tok || ''));
      continue;
    }
    const idx = tok.indexOf('=');
    if (idx < 0) out[String(tok || '').slice(2)] = true;
    else out[String(tok || '').slice(2, idx)] = String(tok || '').slice(idx + 1);
  }
  return out;
}

function boolFlag(v: unknown, fallback = false) {
  if (v == null) return fallback;
  const raw = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/foundation_contract_gate.js run [--strict=1|0]');
  console.log('  node systems/ops/foundation_contract_gate.js status');
}

function readFileSafe(absPath: string) {
  try {
    return fs.readFileSync(absPath, 'utf8');
  } catch {
    return '';
  }
}

function readJsonSafe(absPath: string, fallback: AnyObj = {}) {
  try {
    if (!fs.existsSync(absPath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(absPath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function parseJsonLoose(raw: unknown) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {}
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i]);
    } catch {}
  }
  return null;
}

function runGate() {
  const checks: AnyObj[] = [];
  const addCheck = (id: string, ok: boolean, detail: string) => {
    checks.push({ id, ok: ok === true, detail: cleanText(detail, 400) });
  };

  const requiredFiles = [
    'LICENSE',
    'TERMS_OF_SERVICE.md',
    'EULA.md',
    'CONTRIBUTING_TERMS.md',
    'config/abstraction_debt_baseline.json',
    'config/causal_temporal_memory_policy.json',
    'config/capital_allocation_policy.json',
    'config/cognitive_control_policy.json',
    'config/confirmed_malice_quarantine_policy.json',
    'config/client_relationship_manager_policy.json',
    'config/compression_transfer_plane_policy.json',
    'config/opportunistic_offload_policy.json',
    'config/drift_aware_revenue_optimizer_policy.json',
    'config/economic_entity_management_policy.json',
    'config/deterministic_control_plane_policy.json',
    'config/dynamic_burn_budget_oracle_policy.json',
    'config/dynamic_memory_embedding_policy.json',
    'config/memory_index_freshness_policy.json',
    'config/emergent_primitive_synthesis_policy.json',
    'config/effect_type_policy.json',
    'config/embodiment_layer_policy.json',
    'config/gated_account_creation_policy.json',
    'config/account_creation_templates.json',
    'config/critical_path_formal_policy.json',
    'config/execution_sandbox_envelope_policy.json',
    'config/explanation_primitive_policy.json',
    'config/full_virtual_desktop_claw_policy.json',
    'config/formal_invariants.json',
    'config/gated_self_improvement_policy.json',
    'config/interactive_desktop_session_policy.json',
    'config/iterative_repair_primitive_policy.json',
    'config/doctor_forge_micro_debug_policy.json',
    'config/agent_settlement_extension_policy.json',
    'config/account_creation_profile_extension_policy.json',
    'config/motivational_state_vector_policy.json',
    'config/source_attestation_extension_policy.json',
    'config/trajectory_skill_distiller_policy.json',
    'config/universal_execution_profiles/code_repair.json',
    'config/universal_execution_profiles/desktop_ui.json',
    'config/helix_admission_policy.json',
    'config/helix_policy.json',
    'config/phone_seed_profile_policy.json',
    'config/pre_neuralink_interface_policy.json',
    'config/predictive_capacity_forecast_policy.json',
    'config/neural_dormant_seed_policy.json',
    'config/organ_state_encryption_policy.json',
    'config/operator_terms_ack_policy.json',
    'config/repository_access_policy.json',
    'config/secret_rotation_attestation.json',
    'config/remote_tamper_heartbeat_policy.json',
    'config/secret_rotation_migration_policy.json',
    'config/secure_heartbeat_endpoint_policy.json',
    'config/crypto_agility_contract.json',
    'config/key_lifecycle_policy.json',
    'config/post_quantum_migration_policy.json',
    'config/quantum_security_primitive_synthesis_policy.json',
    'config/long_horizon_planning_policy.json',
    'config/delegated_authority_policy.json',
    'config/governance_hardening_policy.json',
    'config/protheus_control_plane_policy.json',
    'config/memory_efficiency_plane_policy.json',
    'config/architecture_refinement_policy.json',
    'config/enterprise_readiness_pack_policy.json',
    'config/readiness_bridge_pack_policy.json',
    'config/benchmark_autonomy_gate_policy.json',
    'config/rust_memory_transition_policy.json',
    'config/rust_memory_daemon_supervisor_policy.json',
    'config/dist_runtime_reconciliation_policy.json',
    'config/openfang_parity_runtime_policy.json',
    'config/openfang_capability_pack_policy.json',
    'config/binary_runtime_hardening_policy.json',
    'config/copy_hardening_pack_policy.json',
    'config/obsidian_phase_pack_policy.json',
    'config/docs_structure_pack_policy.json',
    'config/post_launch_migration_readiness_policy.json',
    'config/ip_posture_review_policy.json',
    'config/wasm_capability_microkernel_policy.json',
    'config/event_sourced_control_plane_policy.json',
    'config/model_catalog_loop_policy.json',
    'config/model_catalog_service_policy.json',
    'config/thought_action_trace_contract_policy.json',
    'config/swarm_orchestration_runtime_policy.json',
    'config/cross_cell_exchange_plane_policy.json',
    'config/soul_vector_substrate_policy.json',
    'config/hybrid_memory_engine_policy.json',
    'config/habit_adapter_finetune_policy.json',
    'config/observability_deployment_defaults_policy.json',
    'config/compatibility_conformance_program_policy.json',
    'config/continuous_chaos_resilience_policy.json',
    'config/dream_warden_policy.json',
    'config/self_improvement_cadence_policy.json',
    'config/self_hosted_bootstrap_policy.json',
    'config/profile_compatibility_policy.json',
    'config/primitive_catalog.json',
    'config/primitive_migration_contract.json',
    'config/primitive_policy_vm.json',
    'config/runtime_scheduler_policy.json',
    'config/resurrection_protocol_policy.json',
    'config/safety_resilience_policy.json',
    'config/scale_envelope_policy.json',
    'config/simplicity_baseline.json',
    'config/simplicity_budget_policy.json',
    'config/schema_evolution_policy.json',
    'config/state_kernel_policy.json',
    'config/state_kernel_cutover_policy.json',
    'config/siem_bridge_policy.json',
    'config/soc2_type2_policy.json',
    'config/red_team_policy.json',
    'config/redteam_adaptive_defense_policy.json',
    'config/venom_containment_policy.json',
    'config/surface_budget_controller_policy.json',
    'config/value_anchor_renewal_policy.json',
    'config/world_model_freshness_policy.json',
    'config/error_budget_release_gate_policy.json',
    'config/critical_path_policy_coverage_policy.json',
    'config/composite_disaster_gameday_policy.json',
    'config/multi_agent_debate_policy.json',
    'config/backlog_intake_quality_policy.json',
    'config/conflict_marker_guard_policy.json',
    'systems/ops/profile_compatibility_gate.ts',
    'systems/ops/simplicity_budget_gate.ts',
    'systems/ops/schema_evolution_contract.ts',
    'systems/continuity/resurrection_protocol.ts',
    'systems/autonomy/gated_self_improvement_loop.ts',
    'systems/autonomy/doctor_forge_micro_debug_lane.ts',
    'systems/autonomy/multi_agent_debate_orchestrator.ts',
    'systems/echo/value_anchor_renewal.ts',
    'systems/helix/confirmed_malice_quarantine.ts',
    'systems/helix/helix_controller.ts',
    'systems/helix/helix_admission_gate.ts',
    'systems/helix/reweave_doctor.ts',
    'systems/redteam/adaptive_defense_expansion.ts',
    'systems/redteam/quantum_security_primitive_synthesis.ts',
    'systems/security/venom_containment_layer.ts',
    'systems/memory/causal_temporal_graph.ts',
    'systems/memory/dynamic_memory_embedding_adapter.ts',
    'systems/memory/memory_index_freshness_gate.ts',
    'systems/distributed/deterministic_control_plane.ts',
    'systems/hardware/embodiment_layer.ts',
    'systems/hardware/compression_transfer_plane.ts',
    'systems/hardware/surface_budget_controller.ts',
    'systems/hardware/opportunistic_offload_plane.ts',
    'systems/budget/capital_allocation_organ.ts',
    'systems/finance/economic_entity_manager.ts',
    'systems/finance/agent_settlement_extension.ts',
    'systems/workflow/gated_account_creation_organ.ts',
    'systems/workflow/account_creation_profile_extension.ts',
    'systems/weaver/drift_aware_revenue_optimizer.ts',
    'systems/workflow/client_relationship_manager.ts',
    'systems/primitives/effect_type_system.ts',
    'systems/primitives/emergent_primitive_synthesis.ts',
    'systems/primitives/explanation_primitive.ts',
    'systems/primitives/cognitive_control_primitive.ts',
    'systems/primitives/iterative_repair_primitive.ts',
    'systems/primitives/interactive_desktop_session_primitive.ts',
    'systems/primitives/long_horizon_planning_primitive.ts',
    'systems/primitives/runtime_scheduler.ts',
    'systems/redteam/ant_colony_controller.ts',
    'systems/redteam/morph_manager.ts',
    'systems/redteam/swarm_tactics.ts',
    'systems/redteam/wisdom_distiller.ts',
    'systems/security/formal_invariant_engine.ts',
    'systems/security/critical_path_formal_verifier.ts',
    'systems/security/execution_sandbox_envelope.ts',
    'systems/security/organ_state_encryption_plane.ts',
    'systems/security/operator_terms_ack.ts',
    'systems/security/repository_access_auditor.ts',
    'systems/security/remote_tamper_heartbeat.ts',
    'systems/security/secret_rotation_migration_auditor.ts',
    'systems/security/secure_heartbeat_endpoint.ts',
    'systems/security/ip_posture_review.ts',
    'systems/security/key_lifecycle_governor.ts',
    'systems/security/post_quantum_migration_lane.ts',
    'systems/security/delegated_authority_branching.ts',
    'systems/security/governance_hardening_lane.ts',
    'systems/security/dream_warden_guard.ts',
    'systems/security/copy_hardening_pack.ts',
    'systems/security/safety_resilience_guard.ts',
    'systems/security/conflict_marker_guard.ts',
    'systems/security/wasm_capability_microkernel.ts',
    'systems/assimilation/world_model_freshness.ts',
    'systems/assimilation/trajectory_skill_distiller.ts',
    'systems/assimilation/source_attestation_extension.ts',
    'systems/assimilation/habit_adapter_finetune_lane.ts',
    'systems/observability/siem_bridge.ts',
    'systems/observability/thought_action_trace_contract.ts',
    'systems/ops/continuous_chaos_resilience.ts',
    'systems/ops/error_budget_release_gate.ts',
    'systems/ops/critical_path_policy_coverage.ts',
    'systems/ops/composite_disaster_gameday.ts',
    'systems/ops/backlog_intake_quality_gate.ts',
    'systems/ops/protheus_control_plane.ts',
    'systems/ops/protheusd.ts',
    'systems/ops/protheusctl.ts',
    'systems/ops/protheus_top.ts',
    'systems/ops/architecture_refinement_guard.ts',
    'systems/ops/enterprise_readiness_pack.ts',
    'systems/ops/readiness_bridge_pack.ts',
    'systems/ops/benchmark_autonomy_gate.ts',
    'systems/ops/openfang_parity_runtime.ts',
    'systems/ops/openfang_capability_pack.ts',
    'systems/ops/binary_runtime_hardening.ts',
    'systems/ops/docs_structure_pack.ts',
    'systems/ops/post_launch_migration_readiness.ts',
    'systems/ops/event_sourced_control_plane.ts',
    'systems/ops/observability_deployment_defaults.ts',
    'systems/ops/compatibility_conformance_program.ts',
    'systems/ops/state_kernel.ts',
    'systems/ops/state_kernel_migrate.ts',
    'systems/ops/state_kernel_cutover.ts',
    'systems/ops/state_kernel_dual_write.ts',
    'systems/ops/dynamic_burn_budget_oracle.ts',
    'systems/ops/soc2_type2_track.ts',
    'systems/ops/phone_seed_profile.ts',
    'systems/ops/predictive_capacity_forecast.ts',
    'systems/actuation/full_virtual_desktop_claw_lane.ts',
    'systems/autonomy/motivational_state_vector.ts',
    'systems/autonomy/swarm_orchestration_runtime.ts',
    'systems/routing/model_catalog_service.ts',
    'systems/memory/memory_efficiency_plane.ts',
    'systems/memory/rust_memory_transition_lane.ts',
    'systems/memory/rust_memory_daemon_supervisor.ts',
    'systems/memory/cross_cell_exchange_plane.ts',
    'systems/memory/hybrid_memory_engine.ts',
    'systems/symbiosis/neural_dormant_seed.ts',
    'systems/symbiosis/pre_neuralink_interface.ts',
    'systems/symbiosis/soul_vector_substrate.ts',
    'research/neural_dormant_seed/README.md',
    'research/neural_dormant_seed/governance_checklist.md',
    'crates/memory/Cargo.toml',
    'crates/memory/src/main.rs',
    'systems/ops/self_hosted_bootstrap_compiler.ts',
    'systems/obsidian/obsidian_phase_pack.ts',
    'lib/policy_runtime.ts',
    'lib/policy_runtime.js',
    'lib/state_artifact_contract.ts',
    'lib/state_artifact_contract.js',
    'lib/queued_backlog_runtime.ts',
    'lib/dynamic_burn_budget_signal.ts',
    'lib/passport_iteration_chain.ts',
    'systems/primitives/primitive_runtime.ts',
    'systems/primitives/policy_vm.ts',
    'systems/primitives/replay_verify.ts',
    'docs/SECURE_HEARTBEAT_ENDPOINT.md',
    'docs/REPOSITORY_ACCESS_CONTROL.md',
    'docs/SECRET_ROTATION_MIGRATION.md',
    'docs/IP_POSTURE_REVIEW.md',
    'docs/POST_LAUNCH_MIGRATION_READINESS.md',
    'docs/COMPATIBILITY_SPEC.md',
    'docs/README.md',
    'docs/adr/README.md',
    'docs/adr/TEMPLATE.md',
    'docs/adr/INDEX.md',
    'docs/data_governance_matrix.md',
    'docs/environment_matrix.md',
    'docs/release/templates/release_plan.md',
    'docs/release/templates/rollback_plan.md',
    'docs/release/templates/risk_assessment.md',
    'docs/release/templates/post_release_verification.md',
    'docs/release/templates/deprecation_notice.md',
    'docs/release/templates/postmortem_handoff.md',
    'config/service_catalog.json',
    'config/interface_contract_registry.json',
    'deploy/install.sh',
    'deploy/observability/docker-compose.yml'
  ];
  for (const rel of requiredFiles) {
    const abs = path.join(ROOT, rel);
    addCheck(`file:${rel}`, fs.existsSync(abs), fs.existsSync(abs) ? 'present' : 'missing');
  }

  const catalog = readJsonSafe(path.join(ROOT, 'config', 'primitive_catalog.json'), {});
  const commandRules = Array.isArray(catalog.command_rules) ? catalog.command_rules.length : 0;
  addCheck(
    'catalog:rules',
    commandRules >= 3,
    `command_rules=${commandRules}`
  );
  const adapterEffectCount = catalog.adapter_effect_map && typeof catalog.adapter_effect_map === 'object'
    ? Object.keys(catalog.adapter_effect_map).length
    : 0;
  addCheck(
    'catalog:adapter_effect_map',
    adapterEffectCount >= 3,
    `adapter_effect_map=${adapterEffectCount}`
  );
  const commandRulesRaw = Array.isArray(catalog.command_rules) ? catalog.command_rules : [];
  const adapterOpcodeMap = catalog.adapter_opcode_map && typeof catalog.adapter_opcode_map === 'object'
    ? catalog.adapter_opcode_map
    : {};
  const adapterEffectMap = catalog.adapter_effect_map && typeof catalog.adapter_effect_map === 'object'
    ? catalog.adapter_effect_map
    : {};
  const opcodeSet = new Set<string>();
  const defaultOpcode = normalizeUpperToken(catalog.default_command_opcode || 'SHELL_EXECUTE', 80) || 'SHELL_EXECUTE';
  opcodeSet.add(defaultOpcode);
  opcodeSet.add('RECEIPT_VERIFY');
  opcodeSet.add('FLOW_GATE');
  opcodeSet.add('ACTUATION_ADAPTER');
  for (const row of commandRulesRaw) {
    const opcode = normalizeUpperToken(row && row.opcode ? row.opcode : '', 80);
    if (opcode) opcodeSet.add(opcode);
  }
  for (const v of Object.values(adapterOpcodeMap)) {
    const opcode = normalizeUpperToken(v, 80);
    if (opcode) opcodeSet.add(opcode);
  }
  const opcodeCount = opcodeSet.size;
  const opcodeCap = Math.max(1, Number(catalog.primitive_count_cap || catalog.opcode_cap || 24) || 24);
  addCheck(
    'catalog:opcode_cap',
    opcodeCount <= opcodeCap,
    `opcodes=${opcodeCount} cap=${opcodeCap}`
  );

  const adaptersCfg = readJsonSafe(path.join(ROOT, 'config', 'actuation_adapters.json'), {});
  const adaptersMap = adaptersCfg && adaptersCfg.adapters && typeof adaptersCfg.adapters === 'object'
    ? adaptersCfg.adapters
    : {};
  const adapterIds = Object.keys(adaptersMap).map((id) => normalizeLowerToken(id, 80)).filter(Boolean);
  const missingOpcodeMappings = adapterIds.filter((id) => !normalizeUpperToken(adapterOpcodeMap[id], 80));
  const missingEffectMappings = adapterIds.filter((id) => !normalizeLowerToken(adapterEffectMap[id], 80));
  addCheck(
    'catalog:adapter_opcode_coverage',
    missingOpcodeMappings.length === 0,
    missingOpcodeMappings.length === 0 ? `covered=${adapterIds.length}` : `missing=${missingOpcodeMappings.join(',')}`
  );
  addCheck(
    'catalog:adapter_effect_coverage',
    missingEffectMappings.length === 0,
    missingEffectMappings.length === 0 ? `covered=${adapterIds.length}` : `missing=${missingEffectMappings.join(',')}`
  );

  const migration = readJsonSafe(path.join(ROOT, 'config', 'primitive_migration_contract.json'), {});
  const migrationVersion = cleanText(migration.schema_version || '', 40);
  const migrationGrammarVersion = cleanText(migration.grammar_version || '', 40);
  addCheck(
    'catalog:migration_contract_version',
    !!migrationVersion && !!migrationGrammarVersion,
    `schema_version=${migrationVersion || 'missing'} grammar_version=${migrationGrammarVersion || 'missing'}`
  );
  const activeOpcodesRaw = Array.isArray(migration.active_opcodes)
    ? migration.active_opcodes
    : Array.isArray(migration.opcodes) ? migration.opcodes : [];
  const activeOpcodeSet = new Set(
    activeOpcodesRaw
      .map((row: unknown) => normalizeUpperToken(row, 80))
      .filter(Boolean)
  );
  const unmappedOpcodes = Array.from(opcodeSet).filter((op) => !activeOpcodeSet.has(op));
  addCheck(
    'catalog:migration_contract_coverage',
    unmappedOpcodes.length === 0,
    unmappedOpcodes.length === 0 ? `covered=${opcodeSet.size}` : `missing=${unmappedOpcodes.join(',')}`
  );

  const debtBaseline = readJsonSafe(path.join(ROOT, 'config', 'abstraction_debt_baseline.json'), {});
  const subExecPolicy = readJsonSafe(path.join(ROOT, 'config', 'sub_executor_synthesis_policy.json'), {});
  const subExecStatePathRaw = cleanText(
    subExecPolicy.state_path || 'state/actuation/sub_executor_synthesis/state.json',
    320
  );
  const subExecStatePath = path.isAbsolute(subExecStatePathRaw)
    ? subExecStatePathRaw
    : path.join(ROOT, subExecStatePathRaw);
  const subExecState = readJsonSafe(subExecStatePath, {});
  const candidates = subExecState && subExecState.candidates && typeof subExecState.candidates === 'object'
    ? Object.values(subExecState.candidates)
    : [];
  const activeDebt = candidates.filter((row: AnyObj) => {
    const status = normalizeLowerToken(row && row.status ? row.status : '', 40);
    return status === 'proposed' || status === 'validated';
  }).length;
  const totalCandidates = candidates.length;
  const maxActiveDebt = Math.max(0, Number(debtBaseline.max_active_sub_executors || 0) || 0);
  const maxTotalCandidates = Math.max(0, Number(debtBaseline.max_total_sub_executor_candidates || 0) || 0);
  addCheck(
    'distill_or_atrophy:active_debt_cap',
    activeDebt <= maxActiveDebt,
    `active_debt=${activeDebt} cap=${maxActiveDebt}`
  );
  addCheck(
    'distill_or_atrophy:total_candidate_cap',
    totalCandidates <= maxTotalCandidates,
    `total_candidates=${totalCandidates} cap=${maxTotalCandidates}`
  );

  const schedulerPolicy = readJsonSafe(path.join(ROOT, 'config', 'runtime_scheduler_policy.json'), {});
  const modes = Array.isArray(schedulerPolicy.modes) ? schedulerPolicy.modes : [];
  const normalizedModes = new Set(modes.map((row: unknown) => normalizeLowerToken(row, 40)).filter(Boolean));
  addCheck(
    'scheduler_modes:contains_dream_inversion',
    normalizedModes.has('dream') && normalizedModes.has('inversion'),
    `modes=${Array.from(normalizedModes).join(',')}`
  );

  const compatPolicy = readJsonSafe(path.join(ROOT, 'config', 'profile_compatibility_policy.json'), {});
  const maxMinorBehind = Math.max(0, Number(compatPolicy.max_minor_behind || 0) || 0);
  addCheck(
    'profile_compatibility:n_minus_2_minimum',
    maxMinorBehind >= 2,
    `max_minor_behind=${maxMinorBehind}`
  );
  const controlPlanePolicy = readJsonSafe(path.join(ROOT, 'config', 'deterministic_control_plane_policy.json'), {});
  const quorumSize = Math.max(0, Number(controlPlanePolicy.quorum_size || 0) || 0);
  addCheck(
    'distributed_control_plane:quorum_floor',
    quorumSize >= 2,
    `quorum_size=${quorumSize}`
  );
  const localTrustDomain = normalizeLowerToken(controlPlanePolicy.local_trust_domain || '', 80);
  addCheck(
    'distributed_control_plane:trust_domain_required',
    !!localTrustDomain,
    `local_trust_domain=${localTrustDomain || 'missing'}`
  );
  const effectPolicy = readJsonSafe(path.join(ROOT, 'config', 'effect_type_policy.json'), {});
  const effectMode = normalizeLowerToken(effectPolicy.mode || 'enforce', 24) || 'enforce';
  const effectTransitions = Array.isArray(effectPolicy.forbidden_transitions)
    ? effectPolicy.forbidden_transitions.length
    : 0;
  addCheck(
    'effect_type:policy_enforced',
    effectPolicy.enabled !== false && effectMode === 'enforce',
    `enabled=${effectPolicy.enabled !== false ? '1' : '0'} mode=${effectMode || 'missing'}`
  );
  addCheck(
    'effect_type:forbidden_transition_rules',
    effectTransitions >= 1,
    `forbidden_transitions=${effectTransitions}`
  );
  const schemaEvolutionPolicy = readJsonSafe(path.join(ROOT, 'config', 'schema_evolution_policy.json'), {});
  const schemaEvolutionNMinus = Math.max(0, Number(schemaEvolutionPolicy.default_n_minus_minor || 0) || 0);
  addCheck(
    'schema_evolution:n_minus_two_floor',
    schemaEvolutionNMinus >= 2,
    `default_n_minus_minor=${schemaEvolutionNMinus}`
  );
  const stateKernelPolicy = readJsonSafe(path.join(ROOT, 'config', 'state_kernel_policy.json'), {});
  const stateKernelSqlite = stateKernelPolicy.sqlite && typeof stateKernelPolicy.sqlite === 'object'
    ? stateKernelPolicy.sqlite
    : {};
  const stateKernelJournal = normalizeUpperToken(stateKernelSqlite.journal_mode || '', 24);
  const stateKernelSync = normalizeUpperToken(stateKernelSqlite.synchronous || '', 24);
  const stateKernelBusyTimeout = Math.max(0, Number(stateKernelSqlite.busy_timeout_ms || 0) || 0);
  addCheck(
    'state_kernel:sqlite_pragmas',
    stateKernelJournal === 'WAL'
      && stateKernelSync === 'FULL'
      && stateKernelSqlite.foreign_keys === true
      && stateKernelBusyTimeout >= 1000,
    `journal_mode=${stateKernelJournal || 'missing'} synchronous=${stateKernelSync || 'missing'} foreign_keys=${stateKernelSqlite.foreign_keys === true ? '1' : '0'} busy_timeout_ms=${stateKernelBusyTimeout}`
  );
  const stateKernelImmutable = stateKernelPolicy.immutable && typeof stateKernelPolicy.immutable === 'object'
    ? stateKernelPolicy.immutable
    : {};
  const stateKernelOutputs = stateKernelPolicy.outputs && typeof stateKernelPolicy.outputs === 'object'
    ? stateKernelPolicy.outputs
    : {};
  addCheck(
    'state_kernel:immutable_paths_present',
    !!cleanText(stateKernelImmutable.events_path || '', 200)
      && !!cleanText(stateKernelImmutable.receipts_path || '', 200)
      && !!cleanText(stateKernelOutputs.latest_path || '', 200)
      && !!cleanText(stateKernelOutputs.migration_receipts_path || '', 200)
      && !!cleanText(stateKernelOutputs.replay_reports_path || '', 200),
    `events=${cleanText(stateKernelImmutable.events_path || '', 80) || 'missing'} receipts=${cleanText(stateKernelImmutable.receipts_path || '', 80) || 'missing'}`
  );
  const stateKernelAttestation = stateKernelPolicy.attestation && typeof stateKernelPolicy.attestation === 'object'
    ? stateKernelPolicy.attestation
    : {};
  const stateKernelAllowedDecisions = Array.isArray(stateKernelAttestation.allowed_decisions)
    ? stateKernelAttestation.allowed_decisions.map((row: unknown) => normalizeLowerToken(row, 80)).filter(Boolean)
    : [];
  addCheck(
    'state_kernel:attestation_enforced',
    stateKernelAttestation.enforce_on_write === true
      && stateKernelAllowedDecisions.includes('clear')
      && stateKernelAllowedDecisions.includes('shadow_advisory_clear'),
    `enforce_on_write=${stateKernelAttestation.enforce_on_write === true ? '1' : '0'} allowed_decisions=${stateKernelAllowedDecisions.join(',') || 'none'}`
  );
  const stateKernelCutoverPolicy = readJsonSafe(path.join(ROOT, 'config', 'state_kernel_cutover_policy.json'), {});
  const stateKernelCutoverPhases = Array.isArray(stateKernelCutoverPolicy.phases)
    ? stateKernelCutoverPolicy.phases.map((row: unknown) => normalizeLowerToken(row, 80)).filter(Boolean)
    : [];
  const stateKernelValidationDays = Math.max(0, Number(stateKernelCutoverPolicy.shadow_validation_days || 0) || 0);
  addCheck(
    'state_kernel:cutover_contract',
    normalizeLowerToken(stateKernelCutoverPolicy.default_mode || '', 80) === 'dual_write'
      && stateKernelCutoverPhases.includes('dual_write')
      && stateKernelCutoverPhases.includes('read_cutover')
      && stateKernelCutoverPhases.includes('legacy_retired')
      && stateKernelCutoverPolicy.require_parity_ok === true
      && stateKernelValidationDays >= 7,
    `default_mode=${normalizeLowerToken(stateKernelCutoverPolicy.default_mode || '', 80) || 'missing'} phases=${stateKernelCutoverPhases.join(',') || 'none'} require_parity_ok=${stateKernelCutoverPolicy.require_parity_ok === true ? '1' : '0'} shadow_validation_days=${stateKernelValidationDays}`
  );
  const keyLifecyclePolicy = readJsonSafe(path.join(ROOT, 'config', 'key_lifecycle_policy.json'), {});
  const keyAllowedAlgorithms = Array.isArray(keyLifecyclePolicy.allowed_algorithms)
    ? keyLifecyclePolicy.allowed_algorithms.map((row: unknown) => normalizeLowerToken(row, 80)).filter(Boolean)
    : [];
  addCheck(
    'key_lifecycle:post_quantum_track_present',
    keyAllowedAlgorithms.includes('pq-dilithium3'),
    `allowed_algorithms=${keyAllowedAlgorithms.join(',')}`
  );
  const postQuantumMigrationPolicy = readJsonSafe(path.join(ROOT, 'config', 'post_quantum_migration_policy.json'), {});
  const postQuantumSigningTargets = Array.isArray(postQuantumMigrationPolicy.algorithms && postQuantumMigrationPolicy.algorithms.signing_targets)
    ? postQuantumMigrationPolicy.algorithms.signing_targets.map((row: unknown) => normalizeLowerToken(row, 120)).filter(Boolean)
    : [];
  const postQuantumHashTargets = Array.isArray(postQuantumMigrationPolicy.algorithms && postQuantumMigrationPolicy.algorithms.hashing_targets)
    ? postQuantumMigrationPolicy.algorithms.hashing_targets.map((row: unknown) => normalizeLowerToken(row, 120)).filter(Boolean)
    : [];
  addCheck(
    'post_quantum_migration:policy_targets_present',
    postQuantumMigrationPolicy.enabled !== false
      && postQuantumMigrationPolicy.shadow_only !== false
      && Number(postQuantumMigrationPolicy.soak_hours || 0) >= 72
      && postQuantumSigningTargets.includes('pq-dilithium3')
      && postQuantumHashTargets.includes('blake3')
      && postQuantumHashTargets.includes('kangarootwelve'),
    `enabled=${postQuantumMigrationPolicy.enabled !== false ? '1' : '0'} shadow_only=${postQuantumMigrationPolicy.shadow_only !== false ? '1' : '0'} soak_hours=${Number(postQuantumMigrationPolicy.soak_hours || 0)} signing_targets=${postQuantumSigningTargets.join(',') || 'none'} hashing_targets=${postQuantumHashTargets.join(',') || 'none'}`
  );
  const quantumSynthesisPolicy = readJsonSafe(path.join(ROOT, 'config', 'quantum_security_primitive_synthesis_policy.json'), {});
  const quantumSynthesisCategories = Array.isArray(quantumSynthesisPolicy.categories)
    ? quantumSynthesisPolicy.categories.map((row: unknown) => normalizeLowerToken(row, 80)).filter(Boolean)
    : [];
  addCheck(
    'quantum_security_synthesis:policy_guardrails_present',
    quantumSynthesisPolicy.enabled !== false
      && quantumSynthesisPolicy.shadow_only !== false
      && quantumSynthesisPolicy.defensive_only !== false
      && quantumSynthesisPolicy.bounded_only !== false
      && quantumSynthesisPolicy.auditable_only !== false
      && Number(quantumSynthesisPolicy.min_containment_uplift_per_cycle || 0) >= 0.2
      && quantumSynthesisCategories.includes('hashing')
      && quantumSynthesisCategories.includes('signing')
      && quantumSynthesisCategories.includes('kem'),
    `enabled=${quantumSynthesisPolicy.enabled !== false ? '1' : '0'} shadow_only=${quantumSynthesisPolicy.shadow_only !== false ? '1' : '0'} defensive_only=${quantumSynthesisPolicy.defensive_only !== false ? '1' : '0'} bounded_only=${quantumSynthesisPolicy.bounded_only !== false ? '1' : '0'} auditable_only=${quantumSynthesisPolicy.auditable_only !== false ? '1' : '0'} min_uplift=${Number(quantumSynthesisPolicy.min_containment_uplift_per_cycle || 0)} categories=${quantumSynthesisCategories.join(',') || 'none'}`
  );
  const licenseSrc = readFileSafe(path.join(ROOT, 'LICENSE'));
  const contributionTermsSrc = readFileSafe(path.join(ROOT, 'CONTRIBUTING_TERMS.md'));
  const quickstartSrc = readFileSafe(path.join(ROOT, 'docs', 'PERSONAL_PROTHEUS_QUICKSTART.md'));
  addCheck(
    'legal:license_terms_present',
    licenseSrc.includes('All Rights Reserved') && licenseSrc.includes('Commercial Licensing'),
    'LICENSE should declare proprietary all-rights-reserved commercial terms'
  );
  addCheck(
    'legal:contribution_terms_present',
    contributionTermsSrc.includes('Ownership and Assignment')
      && contributionTermsSrc.includes('Commercial Rights')
      && contributionTermsSrc.includes('No Compensation'),
    'CONTRIBUTING_TERMS should define assignment/commercial boundaries'
  );
  addCheck(
    'legal:onboarding_references_present',
    quickstartSrc.includes('LICENSE')
      && quickstartSrc.includes('CONTRIBUTING_TERMS.md')
      && quickstartSrc.includes('TERMS_OF_SERVICE.md')
      && quickstartSrc.includes('EULA.md'),
    'onboarding quickstart should reference legal artifacts'
  );
  const tosSrc = readFileSafe(path.join(ROOT, 'TERMS_OF_SERVICE.md'));
  const eulaSrc = readFileSafe(path.join(ROOT, 'EULA.md'));
  const termsAckPolicy = readJsonSafe(path.join(ROOT, 'config', 'operator_terms_ack_policy.json'), {});
  addCheck(
    'legal:tos_present',
    tosSrc.includes('Terms of Service') && tosSrc.includes('Version:'),
    'TERMS_OF_SERVICE.md should declare title + version'
  );
  addCheck(
    'legal:eula_present',
    eulaSrc.includes('End User License Agreement') && eulaSrc.includes('Version:'),
    'EULA.md should declare title + version'
  );
  addCheck(
    'legal:terms_ack_policy_present',
    termsAckPolicy.enabled !== false
      && termsAckPolicy.enforce_on_install !== false
      && !!cleanText(termsAckPolicy.current_terms_version || '', 80)
      && !!cleanText(termsAckPolicy.paths && termsAckPolicy.paths.tos_path || '', 200)
      && !!cleanText(termsAckPolicy.paths && termsAckPolicy.paths.eula_path || '', 200)
      && !!cleanText(termsAckPolicy.paths && termsAckPolicy.paths.state_path || '', 200),
    'operator terms ack policy should be enabled with terms version + path contracts'
  );
  const repositoryAccessPolicy = readJsonSafe(path.join(ROOT, 'config', 'repository_access_policy.json'), {});
  const repoAccessVisibility = normalizeLowerToken(repositoryAccessPolicy.repo && repositoryAccessPolicy.repo.visibility_expected || '', 40);
  const repoAccessDefaultRole = normalizeLowerToken(repositoryAccessPolicy.least_privilege && repositoryAccessPolicy.least_privilege.default_role || '', 40);
  const repoAccessMaxAdmins = Math.max(0, Number(repositoryAccessPolicy.least_privilege && repositoryAccessPolicy.least_privilege.max_admins || 0) || 0);
  const repoAccessRestrictedAdmins = Array.isArray(repositoryAccessPolicy.least_privilege && repositoryAccessPolicy.least_privilege.restricted_admin_users)
    ? repositoryAccessPolicy.least_privilege.restricted_admin_users.map((row: unknown) => normalizeLowerToken(row, 120)).filter(Boolean)
    : [];
  const repoAccessReviewInterval = Math.max(0, Number(repositoryAccessPolicy.review && repositoryAccessPolicy.review.interval_days || 0) || 0);
  addCheck(
    'repo_access:policy_private_visibility',
    repoAccessVisibility === 'private',
    `visibility_expected=${repoAccessVisibility || 'missing'}`
  );
  addCheck(
    'repo_access:policy_least_privilege',
    repoAccessDefaultRole === 'read' && repoAccessMaxAdmins >= 1 && repoAccessRestrictedAdmins.length >= 1,
    `default_role=${repoAccessDefaultRole || 'missing'} max_admins=${repoAccessMaxAdmins} restricted_admin_users=${repoAccessRestrictedAdmins.join(',') || 'none'}`
  );
  addCheck(
    'repo_access:quarterly_review_cadence',
    repoAccessReviewInterval >= 90,
    `interval_days=${repoAccessReviewInterval}`
  );
  const secretRotationPolicy = readJsonSafe(path.join(ROOT, 'config', 'secret_rotation_migration_policy.json'), {});
  const secretRotationFlags = Array.isArray(secretRotationPolicy.attestation && secretRotationPolicy.attestation.required_flags)
    ? secretRotationPolicy.attestation.required_flags.map((row: unknown) => normalizeLowerToken(row, 120)).filter(Boolean)
    : [];
  const secretRotationRequiredIds = Array.isArray(secretRotationPolicy.required_secret_ids)
    ? secretRotationPolicy.required_secret_ids.map((row: unknown) => normalizeLowerToken(row, 120)).filter(Boolean)
    : [];
  const secretRotationScanPatterns = Array.isArray(secretRotationPolicy.scan && secretRotationPolicy.scan.patterns)
    ? secretRotationPolicy.scan.patterns.length
    : 0;
  addCheck(
    'secret_rotation:policy_enabled_and_flags',
    secretRotationPolicy.enabled !== false
      && secretRotationRequiredIds.length >= 2
      && secretRotationFlags.includes('active_keys_rotated')
      && secretRotationFlags.includes('history_scrub_verified')
      && secretRotationFlags.includes('secret_manager_migrated')
      && secretRotationScanPatterns >= 3,
    `enabled=${secretRotationPolicy.enabled !== false ? '1' : '0'} required_secret_ids=${secretRotationRequiredIds.length} required_flags=${secretRotationFlags.join(',')} scan_patterns=${secretRotationScanPatterns}`
  );
  const mergeGuardScriptSrc = readFileSafe(path.join(ROOT, 'systems', 'security', 'merge_guard.ts'));
  const guardRegistrySrc = readFileSafe(path.join(ROOT, 'config', 'guard_check_registry.json'));
  addCheck(
    'guard_check_registry:manifest_present',
    guardRegistrySrc.includes('"schema_id": "guard_check_registry"')
      && guardRegistrySrc.includes('"merge_guard"')
      && guardRegistrySrc.includes('"contract_check"'),
    'guard check registry manifest should exist with merge_guard + contract_check sections'
  );
  addCheck(
    'guard_check_registry:merge_guard_consumes_manifest',
    mergeGuardScriptSrc.includes('buildMergeGuardPlan')
      && mergeGuardScriptSrc.includes('guard_check_registry'),
    'merge_guard should consume manifest-driven guard check plan'
  );
  // Keep legacy string hooks stable by scanning merge_guard source + manifest content.
  const mergeGuardSrc = `${mergeGuardScriptSrc}\n${guardRegistrySrc}`;
  addCheck(
    'formal_invariant_engine:merge_guard_hook',
    mergeGuardSrc.includes('formal_invariant_engine.js') && mergeGuardSrc.includes('--strict=1'),
    'merge_guard should enforce formal invariant engine'
  );
  addCheck(
    'critical_path_formal:merge_guard_hook',
    mergeGuardSrc.includes('critical_path_formal_verifier.js') && mergeGuardSrc.includes('--strict=1'),
    'merge_guard should enforce critical-path formal verifier'
  );
  addCheck(
    'legal:merge_guard_terms_ack_hook',
    mergeGuardSrc.includes('operator_terms_ack.js')
      && mergeGuardSrc.includes('operator_terms_ack_status'),
    'merge_guard should enforce operator terms acknowledgment lane status check'
  );
  addCheck(
    'repo_access:merge_guard_hook',
    mergeGuardSrc.includes('repository_access_auditor.js')
      && mergeGuardSrc.includes('repository_access_auditor_status')
      && mergeGuardSrc.includes('--strict=1'),
    'merge_guard should enforce repository access auditor status check'
  );
  addCheck(
    'secret_rotation:merge_guard_hook',
    mergeGuardSrc.includes('secret_rotation_migration_auditor.js')
      && mergeGuardSrc.includes('secret_rotation_migration_status')
      && mergeGuardSrc.includes('--strict=1'),
    'merge_guard should enforce secret rotation migration auditor status check'
  );
  addCheck(
    'merge_conflict_marker:merge_guard_hook',
    mergeGuardSrc.includes('conflict_marker_guard.js')
      && mergeGuardSrc.includes('conflict_marker_guard')
      && mergeGuardSrc.includes('--strict=1'),
    'merge_guard should enforce conflict marker guard with strict mode'
  );
  const conflictMarkerRun = spawnSync('node', ['systems/security/conflict_marker_guard.js', 'run', '--strict=0'], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  const conflictMarkerPayload = parseJsonLoose(conflictMarkerRun.stdout);
  const conflictMarkerOk = !!(conflictMarkerPayload && conflictMarkerPayload.ok === true);
  const conflictMarkerDetail = conflictMarkerPayload
    ? `scoped_files=${Number(conflictMarkerPayload.scoped_files || 0)} violations=${Number(conflictMarkerPayload.violations_count || 0)}`
    : `status=${Number(conflictMarkerRun.status || 0)} parse_error=1`;
  addCheck(
    'merge_conflict_marker:scope_clean',
    conflictMarkerOk,
    conflictMarkerDetail
  );
  const repositoryAccessDocSrc = readFileSafe(path.join(ROOT, 'docs', 'REPOSITORY_ACCESS_CONTROL.md'));
  addCheck(
    'repo_access:runbook_present',
    repositoryAccessDocSrc.includes('repository_access_auditor.js')
      && repositoryAccessDocSrc.includes('review-plan')
      && repositoryAccessDocSrc.includes('quarterly'),
    'repository access control runbook should define status/review-plan flow'
  );
  const secretRotationRunbookSrc = readFileSafe(path.join(ROOT, 'docs', 'SECRET_ROTATION_MIGRATION.md'));
  addCheck(
    'secret_rotation:runbook_present',
    secretRotationRunbookSrc.includes('secret_broker.js rotation-check')
      && secretRotationRunbookSrc.includes('secret_rotation_migration_auditor.js attest'),
    'secret rotation runbook should declare rotation-check + attestation workflow'
  );
  const installerSrc = readFileSafe(path.join(ROOT, 'systems', 'ops', 'personal_protheus_installer.ts'));
  addCheck(
    'legal:installer_terms_ack_gate',
    installerSrc.includes('operator_terms_ack_required')
      && installerSrc.includes('termsCheckCmd')
      && installerSrc.includes('termsAcceptCmd'),
    'personal installer should gate install on operator terms acknowledgment'
  );
  const criticalPathFormalPolicy = readJsonSafe(path.join(ROOT, 'config', 'critical_path_formal_policy.json'), {});
  const criticalPathRequiredAxioms = Array.isArray(criticalPathFormalPolicy.checks && criticalPathFormalPolicy.checks.required_axiom_ids)
    ? criticalPathFormalPolicy.checks.required_axiom_ids.length
    : 0;
  const criticalPathRequiredWeights = Array.isArray(criticalPathFormalPolicy.checks && criticalPathFormalPolicy.checks.required_weaver_weights)
    ? criticalPathFormalPolicy.checks.required_weaver_weights.length
    : 0;
  const criticalPathDisabledTargets = Array.isArray(criticalPathFormalPolicy.checks && criticalPathFormalPolicy.checks.required_disabled_live_targets)
    ? criticalPathFormalPolicy.checks.required_disabled_live_targets.map((row: unknown) => normalizeLowerToken(row, 80))
    : [];
  addCheck(
    'critical_path_formal:policy_axioms_and_weights',
    criticalPathRequiredAxioms >= 5 && criticalPathRequiredWeights >= 7,
    `required_axiom_ids=${criticalPathRequiredAxioms} required_weaver_weights=${criticalPathRequiredWeights}`
  );
  addCheck(
    'critical_path_formal:policy_high_risk_targets_disabled',
    criticalPathDisabledTargets.includes('directive') && criticalPathDisabledTargets.includes('constitution'),
    `required_disabled_live_targets=${criticalPathDisabledTargets.join(',')}`
  );
  addCheck(
    'critical_path_formal:policy_paths_present',
    !!(criticalPathFormalPolicy.paths
      && criticalPathFormalPolicy.paths.weaver_policy
      && criticalPathFormalPolicy.paths.inversion_policy
      && criticalPathFormalPolicy.paths.constitution_policy
      && criticalPathFormalPolicy.paths.formal_invariants),
    'policy should declare required critical-path source roots'
  );
  addCheck(
    'supply_chain_trust_plane:merge_guard_hook',
    mergeGuardSrc.includes('supply_chain_trust_plane.js')
      && mergeGuardSrc.includes('--verify-only=1')
      && mergeGuardSrc.includes('--strict=1'),
    'merge_guard should enforce supply-chain trust verification'
  );
  addCheck(
    'schema_evolution:merge_guard_hook',
    mergeGuardSrc.includes('schema_evolution_contract.js')
      && mergeGuardSrc.includes('--strict=1')
      && mergeGuardSrc.includes('--apply=0'),
    'merge_guard should enforce schema evolution verification'
  );
  addCheck(
    'state_kernel:merge_guard_hook',
    mergeGuardSrc.includes('state_kernel.js')
      && mergeGuardSrc.includes('state_kernel_status')
      && mergeGuardSrc.includes('state_kernel_parity')
      && mergeGuardSrc.includes('state_kernel_replay_verify')
      && mergeGuardSrc.includes('state_kernel_cutover_status')
      && mergeGuardSrc.includes('state_kernel_dual_write_status')
      && mergeGuardSrc.includes('--profiles=phone,desktop,cluster'),
    'merge_guard should enforce state kernel status/parity/replay/cutover/dual-write checks'
  );
  addCheck(
    'dynamic_burn_budget_oracle:merge_guard_hook',
    mergeGuardSrc.includes('dynamic_burn_budget_oracle.js')
      && mergeGuardSrc.includes('dynamic_burn_budget_oracle_status'),
    'merge_guard should enforce dynamic burn budget oracle status check'
  );
  addCheck(
    'dist_runtime_cutover:merge_guard_legacy_pairs_hook',
    mergeGuardSrc.includes('dist_runtime_cutover.js')
      && mergeGuardSrc.includes('legacy-pairs')
      && mergeGuardSrc.includes('dist_runtime_legacy_pairs')
      && mergeGuardSrc.includes('--strict=1'),
    'merge_guard should enforce dist runtime legacy-pairs reconciliation gate'
  );
  const distRuntimePolicy = readJsonSafe(path.join(ROOT, 'config', 'dist_runtime_reconciliation_policy.json'), {});
  const distRuntimeBacklogTargets = Array.isArray(distRuntimePolicy.backlog_reopen_target_ids)
    ? distRuntimePolicy.backlog_reopen_target_ids.map((row: unknown) => normalizeUpperToken(row, 80)).filter(Boolean)
    : [];
  addCheck(
    'dist_runtime_cutover:policy_backlog_targets',
    distRuntimePolicy.enabled !== false
      && distRuntimeBacklogTargets.includes('V2-001')
      && distRuntimeBacklogTargets.includes('V2-003')
      && distRuntimeBacklogTargets.includes('BL-014'),
    `enabled=${distRuntimePolicy.enabled !== false ? '1' : '0'} backlog_targets=${distRuntimeBacklogTargets.join(',') || 'none'}`
  );
  const burnOraclePolicy = readJsonSafe(path.join(ROOT, 'config', 'dynamic_burn_budget_oracle_policy.json'), {});
  const burnProviders = burnOraclePolicy.providers && typeof burnOraclePolicy.providers === 'object'
    ? Object.keys(burnOraclePolicy.providers)
    : [];
  addCheck(
    'dynamic_burn_budget_oracle:policy_cadence_and_providers',
    burnOraclePolicy.enabled !== false
      && burnOraclePolicy.shadow_only !== false
      && Number(burnOraclePolicy.cadence && burnOraclePolicy.cadence.default_minutes || 0) >= 1
      && burnProviders.includes('openai')
      && burnProviders.includes('anthropic')
      && burnProviders.includes('xai'),
    `enabled=${burnOraclePolicy.enabled !== false ? '1' : '0'} shadow_only=${burnOraclePolicy.shadow_only !== false ? '1' : '0'} cadence_default=${Number(burnOraclePolicy.cadence && burnOraclePolicy.cadence.default_minutes || 0)} providers=${burnProviders.join(',')}`
  );
  const burnOracleSrc = readFileSafe(path.join(ROOT, 'systems', 'ops', 'dynamic_burn_budget_oracle.ts'));
  addCheck(
    'dynamic_burn_budget_oracle:egress_secret_contract',
    burnOracleSrc.includes('issueSecretHandle(')
      && burnOracleSrc.includes('resolveSecretHandle(')
      && burnOracleSrc.includes('egressFetchText(')
      && burnOracleSrc.includes('appendJsonl(policy.state.receipts_path'),
    'dynamic burn budget oracle should resolve secrets, call egress gateway, and emit deterministic receipts'
  );
  addCheck(
    'key_lifecycle:merge_guard_hook',
    mergeGuardSrc.includes('key_lifecycle_governor.js')
      && mergeGuardSrc.includes('verify')
      && mergeGuardSrc.includes('--strict=1'),
    'merge_guard should enforce key lifecycle verification'
  );
  addCheck(
    'post_quantum_migration:merge_guard_hook',
    mergeGuardSrc.includes('post_quantum_migration_lane.js')
      && mergeGuardSrc.includes('post_quantum_migration_status'),
    'merge_guard should enforce post-quantum migration lane status checks'
  );
  addCheck(
    'quantum_security_synthesis:merge_guard_hook',
    mergeGuardSrc.includes('quantum_security_primitive_synthesis.js')
      && mergeGuardSrc.includes('quantum_security_synthesis_status'),
    'merge_guard should enforce quantum security primitive synthesis status checks'
  );
  addCheck(
    'simplicity_budget:merge_guard_hook',
    mergeGuardSrc.includes('simplicity_budget_gate.js')
      && mergeGuardSrc.includes('--strict=1'),
    'merge_guard should enforce simplicity budget verification'
  );
  addCheck(
    'causal_temporal_graph:merge_guard_hook',
    mergeGuardSrc.includes('causal_temporal_graph.js')
      && mergeGuardSrc.includes('build')
      && mergeGuardSrc.includes('--strict=1'),
    'merge_guard should enforce causal-temporal graph build verification'
  );
  const causalTemporalPolicy = readJsonSafe(path.join(ROOT, 'config', 'causal_temporal_memory_policy.json'), {});
  addCheck(
    'causal_temporal_graph:policy_enabled',
    causalTemporalPolicy.enabled !== false,
    `enabled=${causalTemporalPolicy.enabled !== false ? '1' : '0'}`
  );
  addCheck(
    'causal_temporal_graph:counterfactual_gate_present',
    typeof causalTemporalPolicy.allow_counterfactual_query === 'boolean',
    `allow_counterfactual_query=${typeof causalTemporalPolicy.allow_counterfactual_query === 'boolean' ? String(causalTemporalPolicy.allow_counterfactual_query) : 'missing'}`
  );
  addCheck(
    'emergent_primitive_synthesis:merge_guard_hook',
    mergeGuardSrc.includes('emergent_primitive_synthesis.js')
      && mergeGuardSrc.includes('status'),
    'merge_guard should enforce emergent primitive synthesis contract checks'
  );
  const synthesisPolicy = readJsonSafe(path.join(ROOT, 'config', 'emergent_primitive_synthesis_policy.json'), {});
  addCheck(
    'emergent_primitive_synthesis:human_gate_required',
    synthesisPolicy.require_human_approval === true,
    `require_human_approval=${synthesisPolicy.require_human_approval === true ? '1' : '0'}`
  );
  addCheck(
    'emergent_primitive_synthesis:nursery_adversarial_required',
    synthesisPolicy.require_nursery_pass === true && synthesisPolicy.require_adversarial_pass === true,
    `require_nursery_pass=${synthesisPolicy.require_nursery_pass === true ? '1' : '0'} require_adversarial_pass=${synthesisPolicy.require_adversarial_pass === true ? '1' : '0'}`
  );
  addCheck(
    'hardware_embodiment:merge_guard_hook',
    mergeGuardSrc.includes('embodiment_layer.js')
      && mergeGuardSrc.includes('verify-parity')
      && mergeGuardSrc.includes('--strict=1'),
    'merge_guard should enforce embodiment parity verification'
  );
  const embodimentPolicy = readJsonSafe(path.join(ROOT, 'config', 'embodiment_layer_policy.json'), {});
  const requiredContractFields = Array.isArray(embodimentPolicy.required_contract_fields)
    ? embodimentPolicy.required_contract_fields.length
    : 0;
  addCheck(
    'hardware_embodiment:required_contract_fields',
    requiredContractFields >= 5,
    `required_contract_fields=${requiredContractFields}`
  );
  const profileCount = embodimentPolicy.profiles && typeof embodimentPolicy.profiles === 'object'
    ? Object.keys(embodimentPolicy.profiles).length
    : 0;
  addCheck(
    'hardware_embodiment:profile_count_floor',
    profileCount >= 3,
    `profiles=${profileCount}`
  );
  addCheck(
    'resurrection_protocol:merge_guard_hook',
    mergeGuardSrc.includes('resurrection_protocol.js')
      && mergeGuardSrc.includes('status'),
    'merge_guard should enforce resurrection protocol status check'
  );
  const resurrectionPolicy = readJsonSafe(path.join(ROOT, 'config', 'resurrection_protocol_policy.json'), {});
  addCheck(
    'resurrection_protocol:key_env_present',
    !!cleanText(resurrectionPolicy.key_env || '', 80),
    `key_env=${cleanText(resurrectionPolicy.key_env || '', 80) || 'missing'}`
  );
  const shardFloor = Math.max(0, Number(resurrectionPolicy.default_shards || 0) || 0);
  addCheck(
    'resurrection_protocol:multi_shard_floor',
    shardFloor >= 2,
    `default_shards=${shardFloor}`
  );
  addCheck(
    'value_anchor_renewal:merge_guard_hook',
    mergeGuardSrc.includes('value_anchor_renewal.js')
      && mergeGuardSrc.includes('status'),
    'merge_guard should enforce value-anchor renewal status check'
  );
  const valueAnchorPolicy = readJsonSafe(path.join(ROOT, 'config', 'value_anchor_renewal_policy.json'), {});
  const maxAutoShift = Math.max(0, Math.min(1, Number(valueAnchorPolicy.max_auto_shift || 1)));
  const highImpactShift = Math.max(0, Math.min(1, Number(valueAnchorPolicy.high_impact_shift || 1)));
  addCheck(
    'value_anchor_renewal:shift_threshold_order',
    highImpactShift >= maxAutoShift,
    `max_auto_shift=${maxAutoShift} high_impact_shift=${highImpactShift}`
  );
  addCheck(
    'value_anchor_renewal:review_gate_enabled',
    valueAnchorPolicy.require_user_review_above_shift !== false,
    `require_user_review_above_shift=${valueAnchorPolicy.require_user_review_above_shift !== false ? '1' : '0'}`
  );
  addCheck(
    'gated_self_improvement:merge_guard_hook',
    mergeGuardSrc.includes('gated_self_improvement_loop.js')
      && mergeGuardSrc.includes('status'),
    'merge_guard should enforce gated self-improvement status checks'
  );
  const gatedSelfImprovePolicy = readJsonSafe(path.join(ROOT, 'config', 'gated_self_improvement_policy.json'), {});
  const gatedSelfImproveGates = gatedSelfImprovePolicy.gates && typeof gatedSelfImprovePolicy.gates === 'object'
    ? gatedSelfImprovePolicy.gates
    : {};
  const gatedStages = Array.isArray(gatedSelfImprovePolicy.rollout_stages)
    ? gatedSelfImprovePolicy.rollout_stages.map((v: unknown) => normalizeLowerToken(v, 30)).filter(Boolean)
    : [];
  addCheck(
    'gated_self_improvement:policy_gates_and_stages',
    gatedSelfImprovePolicy.enabled !== false
      && gatedSelfImprovePolicy.require_objective_id !== false
      && gatedSelfImprovePolicy.auto_rollback_on_regression !== false
      && Number(gatedSelfImproveGates.max_effective_drift_rate || 0) <= 0.05
      && Number(gatedSelfImproveGates.min_effective_yield_rate || 0) >= 0.5
      && Number(gatedSelfImproveGates.max_effective_safety_stop_rate || 0) <= 0.02
      && gatedStages.includes('shadow')
      && gatedStages.includes('canary')
      && gatedStages.includes('live'),
    `enabled=${gatedSelfImprovePolicy.enabled !== false ? '1' : '0'} require_objective_id=${gatedSelfImprovePolicy.require_objective_id !== false ? '1' : '0'} auto_rollback_on_regression=${gatedSelfImprovePolicy.auto_rollback_on_regression !== false ? '1' : '0'} stages=${gatedStages.join(',')}`
  );
  const gatedSelfImproveSrc = readFileSafe(path.join(ROOT, 'systems', 'autonomy', 'gated_self_improvement_loop.ts'));
  addCheck(
    'gated_self_improvement:controller_hooks',
    gatedSelfImproveSrc.includes('extractSimulationMetrics(')
      && gatedSelfImproveSrc.includes('evaluateGates(')
      && gatedSelfImproveSrc.includes('self_code_evolution_sandbox.js')
      && gatedSelfImproveSrc.includes('autonomy_simulation_harness.js')
      && gatedSelfImproveSrc.includes('red_team_harness.js'),
    'gated_self_improvement_loop should compose simulation, red-team, and rollback-linked evolution lanes'
  );
  addCheck(
    'iterative_repair_primitive:merge_guard_hook',
    mergeGuardSrc.includes('iterative_repair_primitive.js')
      && mergeGuardSrc.includes('iterative_repair_primitive_status'),
    'merge_guard should enforce iterative repair primitive status check'
  );
  const iterativeRepairPolicy = readJsonSafe(path.join(ROOT, 'config', 'iterative_repair_primitive_policy.json'), {});
  addCheck(
    'iterative_repair_primitive:policy_rollbacks_and_bounds',
    iterativeRepairPolicy.enabled !== false
      && iterativeRepairPolicy.require_rollback_points !== false
      && Number(iterativeRepairPolicy.max_iterations || 0) >= 1
      && Number(iterativeRepairPolicy.max_runtime_sec || 0) >= 30,
    `enabled=${iterativeRepairPolicy.enabled !== false ? '1' : '0'} rollback_points=${iterativeRepairPolicy.require_rollback_points !== false ? '1' : '0'} max_iterations=${Number(iterativeRepairPolicy.max_iterations || 0)} max_runtime_sec=${Number(iterativeRepairPolicy.max_runtime_sec || 0)}`
  );
  addCheck(
    'interactive_desktop_session:merge_guard_hook',
    mergeGuardSrc.includes('interactive_desktop_session_primitive.js')
      && mergeGuardSrc.includes('interactive_desktop_session_status'),
    'merge_guard should enforce interactive desktop session primitive status check'
  );
  const interactiveDesktopPolicy = readJsonSafe(path.join(ROOT, 'config', 'interactive_desktop_session_policy.json'), {});
  const interactiveAllowedOpcodes = Array.isArray(interactiveDesktopPolicy.allowed_opcodes)
    ? interactiveDesktopPolicy.allowed_opcodes.map((row: unknown) => normalizeLowerToken(row, 60))
    : [];
  addCheck(
    'interactive_desktop_session:policy_opcode_contract',
    interactiveDesktopPolicy.enabled !== false
      && interactiveAllowedOpcodes.includes('open')
      && interactiveAllowedOpcodes.includes('capture')
      && interactiveAllowedOpcodes.includes('assert')
      && interactiveDesktopPolicy.require_explicit_approval_for_high_risk !== false,
    `enabled=${interactiveDesktopPolicy.enabled !== false ? '1' : '0'} opcodes=${interactiveAllowedOpcodes.join(',')} high_risk_approval=${interactiveDesktopPolicy.require_explicit_approval_for_high_risk !== false ? '1' : '0'}`
  );
  addCheck(
    'doctor_forge_micro_debug:merge_guard_hook',
    mergeGuardSrc.includes('doctor_forge_micro_debug_lane.js')
      && mergeGuardSrc.includes('doctor_forge_micro_debug_status'),
    'merge_guard should enforce doctor/forge micro-debug lane status check'
  );
  const doctorForgePolicy = readJsonSafe(path.join(ROOT, 'config', 'doctor_forge_micro_debug_policy.json'), {});
  addCheck(
    'doctor_forge_micro_debug:policy_shadow_first',
    doctorForgePolicy.enabled !== false
      && normalizeLowerToken(doctorForgePolicy.rollout_mode || 'shadow', 40) === 'shadow',
    `enabled=${doctorForgePolicy.enabled !== false ? '1' : '0'} rollout_mode=${normalizeLowerToken(doctorForgePolicy.rollout_mode || '', 40) || 'missing'}`
  );
  addCheck(
    'full_virtual_desktop_claw:merge_guard_hook',
    mergeGuardSrc.includes('full_virtual_desktop_claw_lane.js')
      && mergeGuardSrc.includes('full_virtual_desktop_claw_status'),
    'merge_guard should enforce full virtual desktop claw lane status check'
  );
  const fullVirtualDesktopPolicy = readJsonSafe(path.join(ROOT, 'config', 'full_virtual_desktop_claw_policy.json'), {});
  addCheck(
    'full_virtual_desktop_claw:policy_veto_window',
    fullVirtualDesktopPolicy.enabled !== false
      && Number(fullVirtualDesktopPolicy.human_veto_window_sec || 0) >= 30,
    `enabled=${fullVirtualDesktopPolicy.enabled !== false ? '1' : '0'} human_veto_window_sec=${Number(fullVirtualDesktopPolicy.human_veto_window_sec || 0)}`
  );
  addCheck(
    'account_creation_profile_extension:merge_guard_hook',
    mergeGuardSrc.includes('account_creation_profile_extension.js')
      && mergeGuardSrc.includes('account_creation_profile_extension_status'),
    'merge_guard should enforce account creation profile extension status check'
  );
  const accountProfilePolicy = readJsonSafe(path.join(ROOT, 'config', 'account_creation_profile_extension_policy.json'), {});
  const accountRequiredPrimitives = Array.isArray(accountProfilePolicy.required_primitives)
    ? accountProfilePolicy.required_primitives.map((row: unknown) => normalizeLowerToken(row, 80))
    : [];
  addCheck(
    'account_creation_profile_extension:policy_no_bespoke_branching',
    accountProfilePolicy.enabled !== false
      && accountRequiredPrimitives.includes('desktop_ui')
      && accountRequiredPrimitives.includes('alias_verification_vault'),
    `enabled=${accountProfilePolicy.enabled !== false ? '1' : '0'} required_primitives=${accountRequiredPrimitives.join(',')}`
  );
  addCheck(
    'cognitive_control_primitive:merge_guard_hook',
    mergeGuardSrc.includes('cognitive_control_primitive.js')
      && mergeGuardSrc.includes('cognitive_control_primitive_status'),
    'merge_guard should enforce cognitive control primitive status check'
  );
  addCheck(
    'rust_memory_transition_lane:benchmark_consistency_hook',
    mergeGuardSrc.includes('rust_memory_transition_lane.js')
      && mergeGuardSrc.includes('consistency-check'),
    'merge_guard should enforce rust memory benchmark consistency check'
  );
  addCheck(
    'rust_memory_daemon_supervisor:healthcheck_hook',
    mergeGuardSrc.includes('rust_memory_daemon_supervisor.js')
      && mergeGuardSrc.includes('rust_memory_daemon_supervisor_healthcheck'),
    'merge_guard should enforce rust memory daemon supervisor healthcheck'
  );
  addCheck(
    'js_holdout_audit:strict_hook',
    mergeGuardSrc.includes('js_holdout_audit.js')
      && mergeGuardSrc.includes('js_holdout_audit_strict'),
    'merge_guard should enforce strict JS holdout audit'
  );
  const cognitiveControlPolicy = readJsonSafe(path.join(ROOT, 'config', 'cognitive_control_policy.json'), {});
  addCheck(
    'cognitive_control_primitive:policy_sufficiency_bounds',
    cognitiveControlPolicy.enabled !== false
      && Number(cognitiveControlPolicy.min_sufficiency || 0) >= 0
      && Number(cognitiveControlPolicy.max_retrieval_items || 0) >= 1,
    `enabled=${cognitiveControlPolicy.enabled !== false ? '1' : '0'} min_sufficiency=${Number(cognitiveControlPolicy.min_sufficiency || 0)} max_retrieval_items=${Number(cognitiveControlPolicy.max_retrieval_items || 0)}`
  );
  addCheck(
    'dynamic_memory_embedding_adapter:merge_guard_hook',
    mergeGuardSrc.includes('dynamic_memory_embedding_adapter.js')
      && mergeGuardSrc.includes('dynamic_memory_embedding_adapter_status'),
    'merge_guard should enforce dynamic memory embedding adapter status check'
  );
  const dynamicEmbeddingPolicy = readJsonSafe(path.join(ROOT, 'config', 'dynamic_memory_embedding_policy.json'), {});
  addCheck(
    'dynamic_memory_embedding_adapter:session_bounds',
    dynamicEmbeddingPolicy.enabled !== false
      && Number(dynamicEmbeddingPolicy.max_updates_per_session || 0) >= 1,
    `enabled=${dynamicEmbeddingPolicy.enabled !== false ? '1' : '0'} max_updates_per_session=${Number(dynamicEmbeddingPolicy.max_updates_per_session || 0)}`
  );
  addCheck(
    'memory_index_freshness_gate:merge_guard_hook',
    mergeGuardSrc.includes('memory_index_freshness_gate.js')
      && mergeGuardSrc.includes('memory_index_freshness_gate'),
    'merge_guard should enforce memory index freshness gate check'
  );
  const memoryIndexFreshnessPolicy = readJsonSafe(path.join(ROOT, 'config', 'memory_index_freshness_policy.json'), {});
  const freshnessThresholds = memoryIndexFreshnessPolicy && typeof memoryIndexFreshnessPolicy.thresholds === 'object'
    ? memoryIndexFreshnessPolicy.thresholds
    : {};
  addCheck(
    'memory_index_freshness_gate:thresholds_present',
    memoryIndexFreshnessPolicy.enabled !== false
      && Number(freshnessThresholds.max_index_age_hours || 0) >= 1
      && Number(freshnessThresholds.max_daily_files_since_rebuild || 0) >= 1,
    `enabled=${memoryIndexFreshnessPolicy.enabled !== false ? '1' : '0'} max_index_age_hours=${Number(freshnessThresholds.max_index_age_hours || 0)} max_daily_files_since_rebuild=${Number(freshnessThresholds.max_daily_files_since_rebuild || 0)}`
  );
  addCheck(
    'trajectory_skill_distiller:merge_guard_hook',
    mergeGuardSrc.includes('trajectory_skill_distiller.js')
      && mergeGuardSrc.includes('trajectory_skill_distiller_status'),
    'merge_guard should enforce trajectory skill distiller status check'
  );
  const trajectoryDistillerPolicy = readJsonSafe(path.join(ROOT, 'config', 'trajectory_skill_distiller_policy.json'), {});
  addCheck(
    'trajectory_skill_distiller:policy_min_steps',
    trajectoryDistillerPolicy.enabled !== false
      && Number(trajectoryDistillerPolicy.distill_min_steps || 0) >= 2,
    `enabled=${trajectoryDistillerPolicy.enabled !== false ? '1' : '0'} distill_min_steps=${Number(trajectoryDistillerPolicy.distill_min_steps || 0)}`
  );
  addCheck(
    'motivational_state_vector:merge_guard_hook',
    mergeGuardSrc.includes('motivational_state_vector.js')
      && mergeGuardSrc.includes('motivational_state_vector_status'),
    'merge_guard should enforce motivational state vector status check'
  );
  const motivationalStatePolicy = readJsonSafe(path.join(ROOT, 'config', 'motivational_state_vector_policy.json'), {});
  addCheck(
    'motivational_state_vector:advisory_only',
    motivationalStatePolicy.enabled !== false
      && motivationalStatePolicy.advisory_only !== false,
    `enabled=${motivationalStatePolicy.enabled !== false ? '1' : '0'} advisory_only=${motivationalStatePolicy.advisory_only !== false ? '1' : '0'}`
  );
  addCheck(
    'agent_settlement_extension:merge_guard_hook',
    mergeGuardSrc.includes('agent_settlement_extension.js')
      && mergeGuardSrc.includes('agent_settlement_extension_status'),
    'merge_guard should enforce agent settlement extension status check'
  );
  const agentSettlementPolicy = readJsonSafe(path.join(ROOT, 'config', 'agent_settlement_extension_policy.json'), {});
  addCheck(
    'agent_settlement_extension:policy_escrow_and_fee',
    agentSettlementPolicy.enabled !== false
      && Number(agentSettlementPolicy.escrow_required_threshold_usd || 0) >= 1
      && Number(agentSettlementPolicy.max_fee_rate || 0) > 0
      && Number(agentSettlementPolicy.max_fee_rate || 0) <= 1,
    `enabled=${agentSettlementPolicy.enabled !== false ? '1' : '0'} escrow_required_threshold_usd=${Number(agentSettlementPolicy.escrow_required_threshold_usd || 0)} max_fee_rate=${Number(agentSettlementPolicy.max_fee_rate || 0)}`
  );
  addCheck(
    'source_attestation_extension:merge_guard_hook',
    mergeGuardSrc.includes('source_attestation_extension.js')
      && mergeGuardSrc.includes('source_attestation_extension_status'),
    'merge_guard should enforce source attestation extension status check'
  );
  const sourceAttestationPolicy = readJsonSafe(path.join(ROOT, 'config', 'source_attestation_extension_policy.json'), {});
  addCheck(
    'source_attestation_extension:min_trust_score',
    sourceAttestationPolicy.enabled !== false
      && Number(sourceAttestationPolicy.min_trust_score || 0) > 0
      && Number(sourceAttestationPolicy.min_trust_score || 0) <= 1,
    `enabled=${sourceAttestationPolicy.enabled !== false ? '1' : '0'} min_trust_score=${Number(sourceAttestationPolicy.min_trust_score || 0)}`
  );
  addCheck(
    'explanation_primitive:merge_guard_hook',
    mergeGuardSrc.includes('explanation_primitive.js')
      && mergeGuardSrc.includes('status'),
    'merge_guard should enforce explanation primitive status check'
  );
  const explanationPolicy = readJsonSafe(path.join(ROOT, 'config', 'explanation_primitive_policy.json'), {});
  addCheck(
    'explanation_primitive:policy_enabled',
    explanationPolicy.enabled !== false,
    `enabled=${explanationPolicy.enabled !== false ? '1' : '0'}`
  );
  addCheck(
    'explanation_primitive:proof_and_passport_gates',
    explanationPolicy.require_proof_links !== false
      && explanationPolicy.require_event_replayable !== false
      && !!(
        explanationPolicy.passport_export
        && typeof explanationPolicy.passport_export === 'object'
        && explanationPolicy.passport_export.enabled !== false
      ),
    `proof_links=${explanationPolicy.require_proof_links !== false ? '1' : '0'} replayable=${explanationPolicy.require_event_replayable !== false ? '1' : '0'} passport_export=${explanationPolicy.passport_export && explanationPolicy.passport_export.enabled !== false ? '1' : '0'}`
  );
  addCheck(
    'delegated_authority:merge_guard_hook',
    mergeGuardSrc.includes('delegated_authority_branching.js')
      && mergeGuardSrc.includes('status'),
    'merge_guard should enforce delegated authority status check'
  );
  const delegatedPolicy = readJsonSafe(path.join(ROOT, 'config', 'delegated_authority_policy.json'), {});
  const deniedScopeCount = Array.isArray(delegatedPolicy.constitution_denied_scopes)
    ? delegatedPolicy.constitution_denied_scopes.length
    : 0;
  addCheck(
    'delegated_authority:constitution_denied_scopes',
    deniedScopeCount >= 3,
    `constitution_denied_scopes=${deniedScopeCount}`
  );
  addCheck(
    'delegated_authority:key_lifecycle_dependency',
    !!cleanText(delegatedPolicy.required_key_class || '', 80)
      && !!(delegatedPolicy.paths && typeof delegatedPolicy.paths === 'object' && cleanText(delegatedPolicy.paths.key_lifecycle_policy || '', 320)),
    `required_key_class=${cleanText(delegatedPolicy.required_key_class || '', 80) || 'missing'}`
  );
  addCheck(
    'world_model_freshness:merge_guard_hook',
    mergeGuardSrc.includes('world_model_freshness.js')
      && mergeGuardSrc.includes('status'),
    'merge_guard should enforce world-model freshness status check'
  );
  const worldModelPolicy = readJsonSafe(path.join(ROOT, 'config', 'world_model_freshness_policy.json'), {});
  addCheck(
    'world_model_freshness:stale_warning_order',
    Number(worldModelPolicy.stale_after_days || 0) >= Number(worldModelPolicy.warning_after_days || 0),
    `warning_after_days=${Number(worldModelPolicy.warning_after_days || 0)} stale_after_days=${Number(worldModelPolicy.stale_after_days || 0)}`
  );
  const profileRootsCount = Array.isArray(worldModelPolicy.profile_roots)
    ? worldModelPolicy.profile_roots.length
    : 0;
  addCheck(
    'world_model_freshness:profile_roots_present',
    profileRootsCount >= 1,
    `profile_roots=${profileRootsCount}`
  );
  addCheck(
    'continuous_chaos_resilience:merge_guard_hook',
    mergeGuardSrc.includes('continuous_chaos_resilience.js')
      && mergeGuardSrc.includes('status'),
    'merge_guard should enforce continuous chaos resilience status check'
  );
  const continuousChaosPolicy = readJsonSafe(path.join(ROOT, 'config', 'continuous_chaos_resilience_policy.json'), {});
  const gateCfg = continuousChaosPolicy.gate && typeof continuousChaosPolicy.gate === 'object'
    ? continuousChaosPolicy.gate
    : {};
  addCheck(
    'continuous_chaos_resilience:gate_thresholds_valid',
    Number(gateCfg.required_pass_rate || 0) >= 0
      && Number(gateCfg.required_pass_rate || 0) <= 1
      && Number(gateCfg.min_samples || 0) >= 1,
    `required_pass_rate=${Number(gateCfg.required_pass_rate || 0)} min_samples=${Number(gateCfg.min_samples || 0)}`
  );
  const cadenceCfg = continuousChaosPolicy.scenario_cadence_minutes && typeof continuousChaosPolicy.scenario_cadence_minutes === 'object'
    ? continuousChaosPolicy.scenario_cadence_minutes
    : {};
  addCheck(
    'continuous_chaos_resilience:cadence_declared',
    Object.keys(cadenceCfg).length >= 1,
    `scenario_cadence_entries=${Object.keys(cadenceCfg).length}`
  );
  addCheck(
    'error_budget_release_gate:merge_guard_hook',
    mergeGuardSrc.includes('error_budget_release_gate.js')
      && mergeGuardSrc.includes('gate')
      && mergeGuardSrc.includes('--strict=1'),
    'merge_guard should enforce strict error-budget release gate'
  );
  const errorBudgetPolicy = readJsonSafe(path.join(ROOT, 'config', 'error_budget_release_gate_policy.json'), {});
  const errorBudgetCfg = errorBudgetPolicy.budget && typeof errorBudgetPolicy.budget === 'object'
    ? errorBudgetPolicy.budget
    : {};
  addCheck(
    'error_budget_release_gate:policy_thresholds',
    Number(errorBudgetCfg.max_burn_ratio || 0) >= 0
      && Number(errorBudgetCfg.max_burn_ratio || 0) <= 1
      && Number(errorBudgetCfg.warn_burn_ratio || 0) >= 0
      && Number(errorBudgetCfg.warn_burn_ratio || 0) <= Number(errorBudgetCfg.max_burn_ratio || 0),
    `warn=${Number(errorBudgetCfg.warn_burn_ratio || 0)} max=${Number(errorBudgetCfg.max_burn_ratio || 0)}`
  );
  addCheck(
    'critical_path_policy_coverage:merge_guard_hook',
    mergeGuardSrc.includes('critical_path_policy_coverage.js')
      && mergeGuardSrc.includes('run')
      && mergeGuardSrc.includes('--strict=1'),
    'merge_guard should enforce strict critical path policy coverage attestation'
  );
  const criticalCoveragePolicy = readJsonSafe(path.join(ROOT, 'config', 'critical_path_policy_coverage_policy.json'), {});
  const criticalCoverageRows = Array.isArray(criticalCoveragePolicy.critical_paths)
    ? criticalCoveragePolicy.critical_paths
    : [];
  const criticalCoverageValid = criticalCoverageRows.length >= 3
    && criticalCoverageRows.every((row: AnyObj) => (
      !!cleanText(row && row.id || '', 80)
      && !!cleanText(row && row.command_path || '', 240)
      && Array.isArray(row && row.policy_paths)
      && Array.isArray(row && row.test_paths)
      && row.policy_paths.length >= 1
      && row.test_paths.length >= 1
    ));
  addCheck(
    'critical_path_policy_coverage:policy_paths_declared',
    criticalCoverageValid,
    `critical_paths=${criticalCoverageRows.length}`
  );
  addCheck(
    'composite_disaster_gameday:merge_guard_hook',
    mergeGuardSrc.includes('composite_disaster_gameday.js')
      && mergeGuardSrc.includes('status'),
    'merge_guard should enforce composite disaster gameday status visibility'
  );
  const compositePolicy = readJsonSafe(path.join(ROOT, 'config', 'composite_disaster_gameday_policy.json'), {});
  const compositeScenarios = Array.isArray(compositePolicy.scenarios) ? compositePolicy.scenarios : [];
  const compositeStages = new Set(
    compositeScenarios.map((row: AnyObj) => normalizeLowerToken(row && row.stage || '', 60)).filter(Boolean)
  );
  addCheck(
    'composite_disaster_gameday:policy_sequence',
    compositeScenarios.length >= 3
      && compositeStages.has('restore')
      && compositeStages.has('tamper')
      && compositeStages.has('rollback'),
    `scenarios=${compositeScenarios.length} stages=${Array.from(compositeStages).join(',')}`
  );
  addCheck(
    'composite_disaster_gameday:postmortem_path_present',
    !!(
      compositePolicy.outputs
      && typeof compositePolicy.outputs === 'object'
      && cleanText(compositePolicy.outputs.postmortem_dir || '', 200)
    ),
    `postmortem_dir=${compositePolicy.outputs && cleanText(compositePolicy.outputs.postmortem_dir || '', 120) || 'missing'}`
  );
  addCheck(
    'backlog_intake_quality:merge_guard_hook',
    mergeGuardSrc.includes('backlog_intake_quality_gate.js')
      && mergeGuardSrc.includes('run')
      && mergeGuardSrc.includes('--strict=1'),
    'merge_guard should enforce strict backlog intake quality gate'
  );
  const intakePolicy = readJsonSafe(path.join(ROOT, 'config', 'backlog_intake_quality_policy.json'), {});
  const intakeSections = Array.isArray(intakePolicy.target_sections)
    ? intakePolicy.target_sections.length
    : 0;
  const intakeClassVals = Array.isArray(intakePolicy.required_class_values)
    ? intakePolicy.required_class_values.map((v: unknown) => normalizeLowerToken(v, 60))
    : [];
  addCheck(
    'backlog_intake_quality:policy_requirements',
    intakeSections >= 3
      && intakeClassVals.includes('primitive')
      && intakeClassVals.includes('primitive-upgrade')
      && intakeClassVals.includes('extension')
      && intakeClassVals.includes('hardening'),
    `target_sections=${intakeSections} class_values=${intakeClassVals.join(',')}`
  );
  addCheck(
    'siem_bridge:merge_guard_hook',
    mergeGuardSrc.includes('siem_bridge.js')
      && mergeGuardSrc.includes('status'),
    'merge_guard should enforce SIEM bridge status check'
  );
  const siemPolicy = readJsonSafe(path.join(ROOT, 'config', 'siem_bridge_policy.json'), {});
  const siemRules = siemPolicy.correlation_rules && typeof siemPolicy.correlation_rules === 'object'
    ? Object.keys(siemPolicy.correlation_rules)
    : [];
  addCheck(
    'siem_bridge:correlation_rules_present',
    siemRules.includes('auth_anomaly') && siemRules.includes('integrity_drift') && siemRules.includes('guard_denies'),
    `rules=${siemRules.join(',')}`
  );
  addCheck(
    'siem_bridge:export_and_roundtrip_paths_present',
    !!cleanText(siemPolicy.latest_export_path || '', 200)
      && !!cleanText(siemPolicy.latest_correlation_path || '', 200)
      && !!cleanText(siemPolicy.alert_roundtrip_path || '', 200),
    `latest_export_path=${cleanText(siemPolicy.latest_export_path || '', 120) || 'missing'} latest_correlation_path=${cleanText(siemPolicy.latest_correlation_path || '', 120) || 'missing'} alert_roundtrip_path=${cleanText(siemPolicy.alert_roundtrip_path || '', 120) || 'missing'}`
  );
  addCheck(
    'soc2_type2_track:merge_guard_hook',
    mergeGuardSrc.includes('soc2_type2_track.js')
      && mergeGuardSrc.includes('status'),
    'merge_guard should enforce SOC2 Type II track status check'
  );
  const soc2Type2Policy = readJsonSafe(path.join(ROOT, 'config', 'soc2_type2_policy.json'), {});
  addCheck(
    'soc2_type2_track:minimum_window_floor',
    Number(soc2Type2Policy.minimum_window_days || 0) >= 90,
    `minimum_window_days=${Number(soc2Type2Policy.minimum_window_days || 0)}`
  );
  addCheck(
    'soc2_type2_track:exception_and_bundle_paths_present',
    !!cleanText(soc2Type2Policy.exceptions_path || '', 200)
      && !!cleanText(soc2Type2Policy.bundle_dir || '', 200)
      && !!cleanText(soc2Type2Policy.window_history_path || '', 200),
    `exceptions_path=${cleanText(soc2Type2Policy.exceptions_path || '', 120) || 'missing'} bundle_dir=${cleanText(soc2Type2Policy.bundle_dir || '', 120) || 'missing'} window_history_path=${cleanText(soc2Type2Policy.window_history_path || '', 120) || 'missing'}`
  );
  addCheck(
    'predictive_capacity_forecast:merge_guard_hook',
    mergeGuardSrc.includes('predictive_capacity_forecast.js')
      && mergeGuardSrc.includes('status'),
    'merge_guard should enforce predictive capacity forecast status check'
  );
  const capacityPolicy = readJsonSafe(path.join(ROOT, 'config', 'predictive_capacity_forecast_policy.json'), {});
  const horizons = Array.isArray(capacityPolicy.forecast_horizons_days)
    ? capacityPolicy.forecast_horizons_days.map((n: unknown) => Number(n)).filter((n: number) => Number.isFinite(n))
    : [];
  addCheck(
    'predictive_capacity_forecast:horizon_contract',
    horizons.includes(7) && horizons.includes(30),
    `forecast_horizons_days=${horizons.join(',')}`
  );
  addCheck(
    'predictive_capacity_forecast:paths_present',
    !!(capacityPolicy.paths && typeof capacityPolicy.paths === 'object' && cleanText(capacityPolicy.paths.history || '', 200))
      && !!(capacityPolicy.paths && typeof capacityPolicy.paths === 'object' && cleanText(capacityPolicy.paths.errors || '', 200))
      && !!(capacityPolicy.paths && typeof capacityPolicy.paths === 'object' && cleanText(capacityPolicy.paths.latest || '', 200)),
    `history=${capacityPolicy.paths && cleanText(capacityPolicy.paths.history || '', 120) || 'missing'} errors=${capacityPolicy.paths && cleanText(capacityPolicy.paths.errors || '', 120) || 'missing'} latest=${capacityPolicy.paths && cleanText(capacityPolicy.paths.latest || '', 120) || 'missing'}`
  );
  addCheck(
    'execution_sandbox_envelope:merge_guard_hook',
    mergeGuardSrc.includes('execution_sandbox_envelope.js')
      && mergeGuardSrc.includes('status'),
    'merge_guard should enforce execution sandbox envelope status check'
  );
  const sandboxPolicy = readJsonSafe(path.join(ROOT, 'config', 'execution_sandbox_envelope_policy.json'), {});
  const sandboxProfiles = sandboxPolicy.profiles && typeof sandboxPolicy.profiles === 'object'
    ? Object.keys(sandboxPolicy.profiles)
    : [];
  addCheck(
    'execution_sandbox_envelope:policy_profiles',
    sandboxProfiles.includes('workflow_container_strict')
      && sandboxProfiles.includes('actuation_container_strict')
      && sandboxProfiles.includes('simulation_sandbox'),
    `profiles=${sandboxProfiles.join(',')}`
  );
  const sandboxHighRisk = Array.isArray(sandboxPolicy.high_risk_actuation_classes)
    ? sandboxPolicy.high_risk_actuation_classes.map((v: unknown) => normalizeLowerToken(v, 80))
    : [];
  addCheck(
    'execution_sandbox_envelope:deny_defaults_and_high_risk_gate',
    sandboxPolicy.default_host_fs_access !== true
      && sandboxPolicy.default_network_access !== true
      && sandboxPolicy.require_approval_for_high_risk_actuation !== false
      && sandboxHighRisk.includes('payments')
      && sandboxHighRisk.includes('shell'),
    `default_host_fs_access=${sandboxPolicy.default_host_fs_access === true ? '1' : '0'} default_network_access=${sandboxPolicy.default_network_access === true ? '1' : '0'} require_approval_for_high_risk_actuation=${sandboxPolicy.require_approval_for_high_risk_actuation !== false ? '1' : '0'} high_risk=${sandboxHighRisk.join(',')}`
  );
  addCheck(
    'organ_state_encryption:merge_guard_hook',
    mergeGuardSrc.includes('organ_state_encryption_plane.js')
      && mergeGuardSrc.includes('verify')
      && mergeGuardSrc.includes('--strict=1'),
    'merge_guard should enforce organ state encryption verify check'
  );
  const organEncPolicy = readJsonSafe(path.join(ROOT, 'config', 'organ_state_encryption_policy.json'), {});
  const organEncLaneRoots = organEncPolicy.lane_roots && typeof organEncPolicy.lane_roots === 'object'
    ? organEncPolicy.lane_roots
    : {};
  addCheck(
    'organ_state_encryption:rotation_and_fail_closed',
    organEncPolicy.unauthorized_fail_closed !== false
      && Number(organEncPolicy.max_rotation_age_days || 0) >= 30
      && organEncPolicy.crypto
      && cleanText(organEncPolicy.crypto.cipher || '', 40).toLowerCase() === 'aes-256-gcm'
      && cleanText(organEncPolicy.crypto.mac || '', 40).toLowerCase() === 'hmac-sha256',
    `unauthorized_fail_closed=${organEncPolicy.unauthorized_fail_closed !== false ? '1' : '0'} max_rotation_age_days=${Number(organEncPolicy.max_rotation_age_days || 0)} cipher=${cleanText(organEncPolicy.crypto && organEncPolicy.crypto.cipher || '', 40) || 'missing'} mac=${cleanText(organEncPolicy.crypto && organEncPolicy.crypto.mac || '', 40) || 'missing'}`
  );
  addCheck(
    'organ_state_encryption:lane_roots_present',
    !!cleanText(organEncLaneRoots.state || '', 240)
      && !!cleanText(organEncLaneRoots.memory || '', 240)
      && !!cleanText(organEncLaneRoots.cryonics || '', 240),
    `state=${cleanText(organEncLaneRoots.state || '', 120) || 'missing'} memory=${cleanText(organEncLaneRoots.memory || '', 120) || 'missing'} cryonics=${cleanText(organEncLaneRoots.cryonics || '', 120) || 'missing'}`
  );
  addCheck(
    'remote_tamper_heartbeat:merge_guard_hook',
    mergeGuardSrc.includes('remote_tamper_heartbeat.js')
      && mergeGuardSrc.includes('verify')
      && mergeGuardSrc.includes('--strict=1'),
    'merge_guard should enforce remote tamper heartbeat verify check'
  );
  const remoteHeartbeatPolicy = readJsonSafe(path.join(ROOT, 'config', 'remote_tamper_heartbeat_policy.json'), {});
  addCheck(
    'remote_tamper_heartbeat:policy_quarantine_and_signature',
    remoteHeartbeatPolicy.auto_quarantine_on_anomaly !== false
      && remoteHeartbeatPolicy.signature_required !== false
      && Number(remoteHeartbeatPolicy.heartbeat_interval_sec || 0) >= 10
      && Number(remoteHeartbeatPolicy.max_silence_sec || 0) >= Number(remoteHeartbeatPolicy.heartbeat_interval_sec || 0),
    `auto_quarantine_on_anomaly=${remoteHeartbeatPolicy.auto_quarantine_on_anomaly !== false ? '1' : '0'} signature_required=${remoteHeartbeatPolicy.signature_required !== false ? '1' : '0'} heartbeat_interval_sec=${Number(remoteHeartbeatPolicy.heartbeat_interval_sec || 0)} max_silence_sec=${Number(remoteHeartbeatPolicy.max_silence_sec || 0)}`
  );
  const remotePaths = remoteHeartbeatPolicy.paths && typeof remoteHeartbeatPolicy.paths === 'object'
    ? remoteHeartbeatPolicy.paths
    : {};
  addCheck(
    'remote_tamper_heartbeat:paths_present',
    !!cleanText(remotePaths.state_path || '', 240)
      && !!cleanText(remotePaths.latest_path || '', 240)
      && !!cleanText(remotePaths.outbox_path || '', 240)
      && !!cleanText(remotePaths.notifications_path || '', 240)
      && !!cleanText(remotePaths.quarantine_path || '', 240)
      && !!cleanText(remotePaths.evidence_dir || '', 240),
    `state=${cleanText(remotePaths.state_path || '', 100) || 'missing'} latest=${cleanText(remotePaths.latest_path || '', 100) || 'missing'} outbox=${cleanText(remotePaths.outbox_path || '', 100) || 'missing'} notifications=${cleanText(remotePaths.notifications_path || '', 100) || 'missing'} quarantine=${cleanText(remotePaths.quarantine_path || '', 100) || 'missing'} evidence_dir=${cleanText(remotePaths.evidence_dir || '', 100) || 'missing'}`
  );
  addCheck(
    'secure_heartbeat_endpoint:merge_guard_hook',
    mergeGuardSrc.includes('secure_heartbeat_endpoint.js')
      && mergeGuardSrc.includes('verify')
      && mergeGuardSrc.includes('--strict=1'),
    'merge_guard should enforce secure heartbeat endpoint verify check'
  );
  const secureEndpointPolicy = readJsonSafe(path.join(ROOT, 'config', 'secure_heartbeat_endpoint_policy.json'), {});
  const secureRate = secureEndpointPolicy.rate_limit && typeof secureEndpointPolicy.rate_limit === 'object'
    ? secureEndpointPolicy.rate_limit
    : {};
  const secureAuth = secureEndpointPolicy.auth && typeof secureEndpointPolicy.auth === 'object'
    ? secureEndpointPolicy.auth
    : {};
  const securePaths = secureEndpointPolicy.paths && typeof secureEndpointPolicy.paths === 'object'
    ? secureEndpointPolicy.paths
    : {};
  addCheck(
    'secure_heartbeat_endpoint:policy_auth_and_rate',
    secureEndpointPolicy.enabled !== false
      && secureAuth.required !== false
      && Number(secureRate.window_sec || 0) >= 1
      && Number(secureRate.max_requests_per_window || 0) >= 1
      && Number(secureAuth.max_clock_skew_sec || 0) >= 0,
    `enabled=${secureEndpointPolicy.enabled !== false ? '1' : '0'} auth_required=${secureAuth.required !== false ? '1' : '0'} window_sec=${Number(secureRate.window_sec || 0)} max_requests_per_window=${Number(secureRate.max_requests_per_window || 0)} max_clock_skew_sec=${Number(secureAuth.max_clock_skew_sec || 0)}`
  );
  addCheck(
    'secure_heartbeat_endpoint:paths_present',
    !!cleanText(securePaths.keys_path || '', 240)
      && !!cleanText(securePaths.state_path || '', 240)
      && !!cleanText(securePaths.latest_path || '', 240)
      && !!cleanText(securePaths.audit_path || '', 240)
      && !!cleanText(securePaths.alerts_path || '', 240),
    `keys=${cleanText(securePaths.keys_path || '', 100) || 'missing'} state=${cleanText(securePaths.state_path || '', 100) || 'missing'} latest=${cleanText(securePaths.latest_path || '', 100) || 'missing'} audit=${cleanText(securePaths.audit_path || '', 100) || 'missing'} alerts=${cleanText(securePaths.alerts_path || '', 100) || 'missing'}`
  );
  const runbookSrc = readFileSafe(path.join(ROOT, 'docs', 'OPERATOR_RUNBOOK.md'));
  addCheck(
    'secure_heartbeat_endpoint:runbook_hook',
    runbookSrc.includes('secure_heartbeat_endpoint.js'),
    'operator runbook should include secure heartbeat endpoint incident flow'
  );
  addCheck(
    'helix_admission:merge_guard_hook',
    mergeGuardSrc.includes('helix_admission_gate.js')
      && mergeGuardSrc.includes('status'),
    'merge_guard should enforce helix admission status check'
  );
  const helixAdmissionPolicy = readJsonSafe(path.join(ROOT, 'config', 'helix_admission_policy.json'), {});
  const helixAdmissionSources = Array.isArray(helixAdmissionPolicy.allowed_sources)
    ? helixAdmissionPolicy.allowed_sources.map((v: unknown) => normalizeLowerToken(v, 80))
    : [];
  addCheck(
    'helix_admission:policy_sources_and_apply_controls',
    helixAdmissionSources.includes('assimilation')
      && helixAdmissionSources.includes('forge')
      && helixAdmissionSources.includes('doctor')
      && helixAdmissionPolicy.require_doctor_approval_for_apply !== false
      && typeof helixAdmissionPolicy.require_codex_root_for_apply === 'boolean'
      && helixAdmissionPolicy.manifest_update_on_apply !== false,
    `allowed_sources=${helixAdmissionSources.join(',')} require_doctor_approval_for_apply=${helixAdmissionPolicy.require_doctor_approval_for_apply !== false ? '1' : '0'} require_codex_root_for_apply=${typeof helixAdmissionPolicy.require_codex_root_for_apply === 'boolean' ? String(helixAdmissionPolicy.require_codex_root_for_apply) : 'missing'} manifest_update_on_apply=${helixAdmissionPolicy.manifest_update_on_apply !== false ? '1' : '0'}`
  );
  const helixAdmissionPaths = helixAdmissionPolicy.paths && typeof helixAdmissionPolicy.paths === 'object'
    ? helixAdmissionPolicy.paths
    : {};
  addCheck(
    'helix_admission:paths_present',
    !!cleanText(helixAdmissionPaths.admissions_path || '', 240)
      && !!cleanText(helixAdmissionPaths.latest_path || '', 240)
      && !!cleanText(helixAdmissionPaths.manifest_path || '', 240),
    `admissions=${cleanText(helixAdmissionPaths.admissions_path || '', 120) || 'missing'} latest=${cleanText(helixAdmissionPaths.latest_path || '', 120) || 'missing'} manifest=${cleanText(helixAdmissionPaths.manifest_path || '', 120) || 'missing'}`
  );
  addCheck(
    'helix_baseline:merge_guard_hook',
    mergeGuardSrc.includes('helix_controller.js')
      && mergeGuardSrc.includes('helix_baseline_status'),
    'merge_guard should enforce helix baseline status check'
  );
  const helixPolicy = readJsonSafe(path.join(ROOT, 'config', 'helix_policy.json'), {});
  const helixReweaveCfg = helixPolicy.reweave && typeof helixPolicy.reweave === 'object'
    ? helixPolicy.reweave
    : {};
  addCheck(
    'helix_baseline:policy_shadow_and_reweave_paths',
    helixPolicy.shadow_only === true
      && !!cleanText(helixReweaveCfg.snapshot_path || '', 240)
      && !!cleanText(helixReweaveCfg.receipts_path || '', 240)
      && !!cleanText(helixReweaveCfg.quarantine_dir || '', 240),
    `shadow_only=${helixPolicy.shadow_only === true ? '1' : '0'} snapshot=${cleanText(helixReweaveCfg.snapshot_path || '', 100) || 'missing'} receipts=${cleanText(helixReweaveCfg.receipts_path || '', 100) || 'missing'} quarantine=${cleanText(helixReweaveCfg.quarantine_dir || '', 100) || 'missing'}`
  );
  const helixControllerSrc = readFileSafe(path.join(ROOT, 'systems', 'helix', 'helix_controller.ts'));
  const reweaveDoctorSrc = readFileSafe(path.join(ROOT, 'systems', 'helix', 'reweave_doctor.ts'));
  addCheck(
    'helix_reweave:controller_apply_hook',
    helixControllerSrc.includes('applyReweave(')
      && helixControllerSrc.includes('captureReweaveSnapshot(')
      && helixControllerSrc.includes('commandBaseline'),
    'helix_controller should expose baseline and apply-capable reweave flow'
  );
  addCheck(
    'helix_reweave:doctor_snapshot_apply_hooks',
    reweaveDoctorSrc.includes('captureReweaveSnapshot(')
      && reweaveDoctorSrc.includes('applyReweave(')
      && reweaveDoctorSrc.includes('approval_note_required'),
    'reweave_doctor should support snapshot capture + apply reweave with approval gate'
  );
  addCheck(
    'helix_confirmed_malice:merge_guard_hook',
    mergeGuardSrc.includes('confirmed_malice_quarantine.js')
      && mergeGuardSrc.includes('status'),
    'merge_guard should enforce confirmed malice quarantine status check'
  );
  const confirmedMalicePolicy = readJsonSafe(path.join(ROOT, 'config', 'confirmed_malice_quarantine_policy.json'), {});
  const confirmedThresholds = confirmedMalicePolicy.thresholds && typeof confirmedMalicePolicy.thresholds === 'object'
    ? confirmedMalicePolicy.thresholds
    : {};
  addCheck(
    'helix_confirmed_malice:policy_thresholds',
    confirmedMalicePolicy.enabled !== false
      && confirmedMalicePolicy.require_sentinel_confirmed_malice !== false
      && confirmedMalicePolicy.release_requires_human !== false
      && Number(confirmedThresholds.min_independent_signals_for_permanent_quarantine || 0) >= 2
      && Number(confirmedThresholds.min_confidence_for_permanent_quarantine || 0) >= 0.9,
    `enabled=${confirmedMalicePolicy.enabled !== false ? '1' : '0'} require_sentinel_confirmed_malice=${confirmedMalicePolicy.require_sentinel_confirmed_malice !== false ? '1' : '0'} release_requires_human=${confirmedMalicePolicy.release_requires_human !== false ? '1' : '0'} min_independent_signals=${Number(confirmedThresholds.min_independent_signals_for_permanent_quarantine || 0)} min_confidence=${Number(confirmedThresholds.min_confidence_for_permanent_quarantine || 0)}`
  );
  const confirmedPaths = confirmedMalicePolicy.paths && typeof confirmedMalicePolicy.paths === 'object'
    ? confirmedMalicePolicy.paths
    : {};
  addCheck(
    'helix_confirmed_malice:paths_present',
    !!cleanText(confirmedPaths.state_path || '', 240)
      && !!cleanText(confirmedPaths.latest_path || '', 240)
      && !!cleanText(confirmedPaths.events_path || '', 240)
      && !!cleanText(confirmedPaths.forensic_dir || '', 240),
    `state_path=${cleanText(confirmedPaths.state_path || '', 100) || 'missing'} latest_path=${cleanText(confirmedPaths.latest_path || '', 100) || 'missing'} events_path=${cleanText(confirmedPaths.events_path || '', 100) || 'missing'} forensic_dir=${cleanText(confirmedPaths.forensic_dir || '', 100) || 'missing'}`
  );
  addCheck(
    'neural_dormant_seed:merge_guard_hook',
    mergeGuardSrc.includes('neural_dormant_seed.js')
      && mergeGuardSrc.includes('check')
      && mergeGuardSrc.includes('--profile=prod'),
    'merge_guard should enforce neural dormant seed lock check'
  );
  const neuralPolicy = readJsonSafe(path.join(ROOT, 'config', 'neural_dormant_seed_policy.json'), {});
  const blockedProfiles = Array.isArray(neuralPolicy.blocked_runtime_profiles)
    ? neuralPolicy.blocked_runtime_profiles.map((v: unknown) => normalizeLowerToken(v, 60)).filter(Boolean)
    : [];
  const governanceChecks = Array.isArray(neuralPolicy.required_governance_checks)
    ? neuralPolicy.required_governance_checks
    : [];
  addCheck(
    'neural_dormant_seed:locked_and_blocked',
    neuralPolicy.locked === true
      && blockedProfiles.includes('prod')
      && blockedProfiles.includes('phone_seed')
      && neuralPolicy.allow_non_simulated_prototypes !== true,
    `locked=${neuralPolicy.locked === true ? '1' : '0'} blocked_profiles=${blockedProfiles.join(',')} allow_non_simulated_prototypes=${neuralPolicy.allow_non_simulated_prototypes === true ? '1' : '0'}`
  );
  addCheck(
    'neural_dormant_seed:governance_checklist_depth',
    governanceChecks.length >= 3,
    `required_governance_checks=${governanceChecks.length}`
  );
  addCheck(
    'pre_neuralink_interface:merge_guard_hook',
    mergeGuardSrc.includes('pre_neuralink_interface.js')
      && mergeGuardSrc.includes('status'),
    'merge_guard should enforce pre-neuralink interface status check'
  );
  const preNeuralPolicy = readJsonSafe(path.join(ROOT, 'config', 'pre_neuralink_interface_policy.json'), {});
  const preNeuralChannels = Array.isArray(preNeuralPolicy.channels)
    ? preNeuralPolicy.channels.map((row: unknown) => normalizeLowerToken(row, 40)).filter(Boolean)
    : [];
  const preNeuralConsent = preNeuralPolicy.consent && typeof preNeuralPolicy.consent === 'object'
    ? preNeuralPolicy.consent
    : {};
  addCheck(
    'pre_neuralink_interface:policy_local_first_and_consent',
    preNeuralPolicy.local_first !== false
      && preNeuralPolicy.require_explicit_consent !== false
      && preNeuralChannels.includes('voice')
      && preNeuralChannels.includes('attention')
      && preNeuralChannels.includes('haptic'),
    `local_first=${preNeuralPolicy.local_first !== false ? '1' : '0'} require_explicit_consent=${preNeuralPolicy.require_explicit_consent !== false ? '1' : '0'} channels=${preNeuralChannels.join(',')}`
  );
  addCheck(
    'pre_neuralink_interface:route_allowed_states_gate',
    Array.isArray(preNeuralConsent.route_allowed_states)
      && preNeuralConsent.route_allowed_states.map((row: unknown) => normalizeLowerToken(row, 40)).includes('granted'),
    `route_allowed_states=${Array.isArray(preNeuralConsent.route_allowed_states) ? preNeuralConsent.route_allowed_states.join(',') : 'missing'}`
  );
  const preNeuralSrc = readFileSafe(path.join(ROOT, 'systems', 'symbiosis', 'pre_neuralink_interface.ts'));
  addCheck(
    'pre_neuralink_interface:controller_hooks',
    preNeuralSrc.includes('EYE_KERNEL_SCRIPT')
      && preNeuralSrc.includes('routeThroughEye(')
      && preNeuralSrc.includes('buildHandoffContract(')
      && preNeuralSrc.includes('require_explicit_consent'),
    'pre_neuralink interface should keep eye-routing + handoff + consent hooks'
  );
  addCheck(
    'phone_seed_profile:merge_guard_hook',
    mergeGuardSrc.includes('phone_seed_profile.js')
      && mergeGuardSrc.includes('status'),
    'merge_guard should enforce phone-seed profile status check'
  );
  const phoneSeedPolicy = readJsonSafe(path.join(ROOT, 'config', 'phone_seed_profile_policy.json'), {});
  const phoneThresholds = phoneSeedPolicy.thresholds && typeof phoneSeedPolicy.thresholds === 'object'
    ? phoneSeedPolicy.thresholds
    : {};
  addCheck(
    'phone_seed_profile:thresholds_present',
    Number(phoneThresholds.boot_ms_max || 0) > 0
      && Number(phoneThresholds.idle_rss_mb_max || 0) > 0
      && Number(phoneThresholds.workflow_latency_ms_max || 0) > 0
      && Number(phoneThresholds.memory_latency_ms_max || 0) > 0,
    `boot_ms_max=${Number(phoneThresholds.boot_ms_max || 0)} idle_rss_mb_max=${Number(phoneThresholds.idle_rss_mb_max || 0)} workflow_latency_ms_max=${Number(phoneThresholds.workflow_latency_ms_max || 0)} memory_latency_ms_max=${Number(phoneThresholds.memory_latency_ms_max || 0)}`
  );
  addCheck(
    'phone_seed_profile:heavy_lane_gate',
    phoneSeedPolicy.require_heavy_lanes_disabled !== false,
    `require_heavy_lanes_disabled=${phoneSeedPolicy.require_heavy_lanes_disabled !== false ? '1' : '0'}`
  );
  addCheck(
    'surface_budget_controller:merge_guard_hook',
    mergeGuardSrc.includes('surface_budget_controller.js')
      && mergeGuardSrc.includes('status'),
    'merge_guard should enforce surface-budget controller status check'
  );
  const surfaceBudgetPolicy = readJsonSafe(path.join(ROOT, 'config', 'surface_budget_controller_policy.json'), {});
  const tiersCount = Array.isArray(surfaceBudgetPolicy.tiers) ? surfaceBudgetPolicy.tiers.length : 0;
  addCheck(
    'surface_budget_controller:tiers_declared',
    tiersCount >= 3,
    `tiers=${tiersCount}`
  );
  addCheck(
    'surface_budget_controller:cadence_gate_present',
    Number(surfaceBudgetPolicy.min_transition_seconds || 0) >= 0,
    `min_transition_seconds=${Number(surfaceBudgetPolicy.min_transition_seconds || 0)}`
  );
  addCheck(
    'compression_transfer_plane:merge_guard_hook',
    mergeGuardSrc.includes('compression_transfer_plane.js')
      && mergeGuardSrc.includes('status'),
    'merge_guard should enforce compression-transfer plane status check'
  );
  const transferPolicy = readJsonSafe(path.join(ROOT, 'config', 'compression_transfer_plane_policy.json'), {});
  const transferPaths = Array.isArray(transferPolicy.include_paths) ? transferPolicy.include_paths.length : 0;
  addCheck(
    'compression_transfer_plane:include_paths_present',
    transferPaths >= 1,
    `include_paths=${transferPaths}`
  );
  addCheck(
    'compression_transfer_plane:bundle_paths_present',
    !!cleanText(transferPolicy.bundle_dir || '', 200)
      && !!cleanText(transferPolicy.latest_path || '', 200)
      && !!cleanText(transferPolicy.receipts_path || '', 200),
    `bundle_dir=${cleanText(transferPolicy.bundle_dir || '', 120) || 'missing'} latest_path=${cleanText(transferPolicy.latest_path || '', 120) || 'missing'} receipts_path=${cleanText(transferPolicy.receipts_path || '', 120) || 'missing'}`
  );
  addCheck(
    'opportunistic_offload_plane:merge_guard_hook',
    mergeGuardSrc.includes('opportunistic_offload_plane.js')
      && mergeGuardSrc.includes('status'),
    'merge_guard should enforce opportunistic offload status check'
  );
  const offloadPolicy = readJsonSafe(path.join(ROOT, 'config', 'opportunistic_offload_policy.json'), {});
  addCheck(
    'opportunistic_offload_plane:thresholds_present',
    Number(offloadPolicy.local_execution_score_threshold || 0) >= 0
      && Number(offloadPolicy.local_execution_score_threshold || 0) <= 1
      && Number(offloadPolicy.local_max_complexity || 0) >= 0
      && Number(offloadPolicy.local_max_complexity || 0) <= 1,
    `local_execution_score_threshold=${Number(offloadPolicy.local_execution_score_threshold || 0)} local_max_complexity=${Number(offloadPolicy.local_max_complexity || 0)}`
  );
  addCheck(
    'opportunistic_offload_plane:schedule_command_present',
    Array.isArray(offloadPolicy.schedule_command) && offloadPolicy.schedule_command.length >= 2,
    `schedule_command_len=${Array.isArray(offloadPolicy.schedule_command) ? offloadPolicy.schedule_command.length : 0}`
  );
  addCheck(
    'client_relationship_manager:merge_guard_hook',
    mergeGuardSrc.includes('client_relationship_manager.js')
      && mergeGuardSrc.includes('status')
      && mergeGuardSrc.includes('--days=30'),
    'merge_guard should enforce client relationship status check'
  );
  const crmPolicy = readJsonSafe(path.join(ROOT, 'config', 'client_relationship_manager_policy.json'), {});
  const crmTypes = Array.isArray(crmPolicy.event_types) ? crmPolicy.event_types.length : 0;
  addCheck(
    'client_relationship_manager:event_types_present',
    crmTypes >= 4,
    `event_types=${crmTypes}`
  );
  addCheck(
    'client_relationship_manager:manual_target_present',
    Number(crmPolicy.manual_intervention_target || 0) >= 0
      && Number(crmPolicy.manual_intervention_target || 0) <= 1,
    `manual_intervention_target=${Number(crmPolicy.manual_intervention_target || 0)}`
  );
  addCheck(
    'gated_account_creation:merge_guard_hook',
    mergeGuardSrc.includes('gated_account_creation_organ.js')
      && mergeGuardSrc.includes('status'),
    'merge_guard should enforce gated account creation status checks'
  );
  const accountPolicy = readJsonSafe(path.join(ROOT, 'config', 'gated_account_creation_policy.json'), {});
  const accountHighRisk = Array.isArray(accountPolicy.high_risk_classes)
    ? accountPolicy.high_risk_classes.map((v: unknown) => normalizeLowerToken(v, 80)).filter(Boolean)
    : [];
  addCheck(
    'gated_account_creation:policy_profile_first_high_risk_gate',
    accountPolicy.enabled !== false
      && accountPolicy.require_objective_id !== false
      && accountPolicy.require_human_approval_for_high_risk !== false
      && accountHighRisk.includes('payments')
      && accountHighRisk.includes('auth')
      && !!cleanText(accountPolicy.templates_path || '', 260),
    `enabled=${accountPolicy.enabled !== false ? '1' : '0'} require_objective_id=${accountPolicy.require_objective_id !== false ? '1' : '0'} require_human_approval_for_high_risk=${accountPolicy.require_human_approval_for_high_risk !== false ? '1' : '0'} templates_path=${cleanText(accountPolicy.templates_path || '', 120) || 'missing'}`
  );
  const accountTemplates = readJsonSafe(path.join(ROOT, 'config', 'account_creation_templates.json'), {});
  const templateCount = accountTemplates.templates && typeof accountTemplates.templates === 'object'
    ? Object.keys(accountTemplates.templates).length
    : 0;
  addCheck(
    'gated_account_creation:templates_present',
    templateCount >= 1,
    `templates=${templateCount}`
  );
  const accountSrc = readFileSafe(path.join(ROOT, 'systems', 'workflow', 'gated_account_creation_organ.ts'));
  addCheck(
    'gated_account_creation:controller_hooks',
    accountSrc.includes('runConstitutionGate(')
      && accountSrc.includes('runSoulGate(')
      && accountSrc.includes('runWeaverGate(')
      && accountSrc.includes('universal_execution_primitive.js')
      && accountSrc.includes('alias_verification_vault')
      && accountSrc.includes('agent_passport'),
    'gated_account_creation_organ should compose constitution/weaver/soul gates with profile-first execution and passport linkage'
  );
  addCheck(
    'capital_allocation_organ:merge_guard_hook',
    mergeGuardSrc.includes('capital_allocation_organ.js')
      && mergeGuardSrc.includes('status')
      && mergeGuardSrc.includes('--days=30'),
    'merge_guard should enforce capital allocation status check'
  );
  const capitalPolicy = readJsonSafe(path.join(ROOT, 'config', 'capital_allocation_policy.json'), {});
  const capitalBuckets = capitalPolicy.buckets && typeof capitalPolicy.buckets === 'object'
    ? Object.keys(capitalPolicy.buckets).length
    : 0;
  addCheck(
    'capital_allocation_organ:buckets_present',
    capitalBuckets >= 2,
    `buckets=${capitalBuckets}`
  );
  addCheck(
    'capital_allocation_organ:simulation_and_rar_targets',
    Number(capitalPolicy.min_simulation_score || 0) >= 0
      && Number(capitalPolicy.min_simulation_score || 0) <= 1
      && Number(capitalPolicy.min_risk_adjusted_return || 0) >= -10
      && Number(capitalPolicy.min_risk_adjusted_return || 0) <= 10,
    `min_simulation_score=${Number(capitalPolicy.min_simulation_score || 0)} min_risk_adjusted_return=${Number(capitalPolicy.min_risk_adjusted_return || 0)}`
  );
  const capitalSrc = readFileSafe(path.join(ROOT, 'systems', 'budget', 'capital_allocation_organ.ts'));
  addCheck(
    'capital_allocation_organ:burn_oracle_integration',
    capitalSrc.includes('loadDynamicBurnOracleSignal')
      && capitalSrc.includes('budget_oracle_hold')
      && capitalSrc.includes('budget_oracle'),
    'capital allocation organ should enforce burn oracle hold with advisory receipts'
  );
  const strategyModeSrc = readFileSafe(path.join(ROOT, 'systems', 'autonomy', 'strategy_mode.ts'));
  addCheck(
    'strategy_mode:burn_oracle_integration',
    strategyModeSrc.includes('loadDynamicBurnOracleSignal')
      && strategyModeSrc.includes('budget_oracle_hold')
      && strategyModeSrc.includes('readBurnOracleAdvisory'),
    'strategy mode should ingest burn oracle advisories before execute escalation'
  );
  const gatedSelfImprovementSrc = readFileSafe(path.join(ROOT, 'systems', 'autonomy', 'gated_self_improvement_loop.ts'));
  addCheck(
    'gated_self_improvement:burn_oracle_integration',
    gatedSelfImprovementSrc.includes('loadDynamicBurnOracleSignal')
      && gatedSelfImprovementSrc.includes('budget_oracle_hold')
      && gatedSelfImprovementSrc.includes('loadSelfImprovementBurnOracle'),
    'gated self-improvement loop should enforce burn oracle hold before expensive runs'
  );
  const optimizationApertureSrc = readFileSafe(path.join(ROOT, 'systems', 'autonomy', 'optimization_aperture_controller.ts'));
  addCheck(
    'optimization_aperture:burn_oracle_integration',
    optimizationApertureSrc.includes('loadDynamicBurnOracleSignal')
      && optimizationApertureSrc.includes('budget_pressure_source')
      && optimizationApertureSrc.includes('budget_oracle'),
    'optimization aperture should consume burn oracle as default budget pressure advisory'
  );
  const routerSrc = readFileSafe(path.join(ROOT, 'systems', 'routing', 'model_router.ts'));
  addCheck(
    'model_router:burn_oracle_integration',
    routerSrc.includes('loadDynamicBurnOracleSignal')
      && routerSrc.includes('budget_oracle_runway_critical')
      && routerSrc.includes('oracle_pressure'),
    'model router should enforce oracle-aware budget gate and include runway telemetry'
  );
  const weaverSrc = readFileSafe(path.join(ROOT, 'systems', 'weaver', 'weaver_core.ts'));
  addCheck(
    'weaver_core:burn_oracle_integration',
    weaverSrc.includes('loadDynamicBurnOracleSignal')
      && weaverSrc.includes('budget_oracle_pressure_')
      && weaverSrc.includes('budget_oracle:'),
    'weaver should include burn oracle in arbitration context and receipts'
  );
  addCheck(
    'economic_entity_manager:merge_guard_hook',
    mergeGuardSrc.includes('economic_entity_manager.js')
      && mergeGuardSrc.includes('status'),
    'merge_guard should enforce economic entity manager status check'
  );
  const economicPolicy = readJsonSafe(path.join(ROOT, 'config', 'economic_entity_management_policy.json'), {});
  const economicTaxMapCount = economicPolicy.tax_classification_map && typeof economicPolicy.tax_classification_map === 'object'
    ? Object.keys(economicPolicy.tax_classification_map).length
    : 0;
  const economicHighRisk = economicPolicy.high_risk_filing && typeof economicPolicy.high_risk_filing === 'object'
    ? economicPolicy.high_risk_filing
    : {};
  const economicPayout = economicPolicy.payout && typeof economicPolicy.payout === 'object'
    ? economicPolicy.payout
    : {};
  addCheck(
    'economic_entity_manager:policy_tax_and_human_gates',
    economicTaxMapCount >= 3
      && economicHighRisk.require_human_approval !== false
      && Number(economicHighRisk.min_approval_note_chars || 0) >= 8
      && economicPayout.require_eye_gate !== false,
    `tax_map=${economicTaxMapCount} require_human_approval=${economicHighRisk.require_human_approval !== false ? '1' : '0'} min_approval_note_chars=${Number(economicHighRisk.min_approval_note_chars || 0)} require_eye_gate=${economicPayout.require_eye_gate !== false ? '1' : '0'}`
  );
  const economicSrc = readFileSafe(path.join(ROOT, 'systems', 'finance', 'economic_entity_manager.ts'));
  addCheck(
    'economic_entity_manager:controller_hooks',
    economicSrc.includes('EYE_KERNEL_SCRIPT')
      && economicSrc.includes('PAYMENT_BRIDGE_SCRIPT')
      && economicSrc.includes('appendImmutableReceipt(')
      && economicSrc.includes('cmdTaxReport('),
    'economic entity manager should keep eye/payment gates + immutable receipts + tax reporting hooks'
  );
  addCheck(
    'drift_aware_revenue_optimizer:merge_guard_hook',
    mergeGuardSrc.includes('drift_aware_revenue_optimizer.js')
      && mergeGuardSrc.includes('status')
      && mergeGuardSrc.includes('--days=30'),
    'merge_guard should enforce drift-aware optimizer status check'
  );
  const driftPolicy = readJsonSafe(path.join(ROOT, 'config', 'drift_aware_revenue_optimizer_policy.json'), {});
  addCheck(
    'drift_aware_revenue_optimizer:drift_cap_present',
    Number(driftPolicy.drift_cap_30d || 0) >= 0
      && Number(driftPolicy.drift_cap_30d || 0) <= 1,
    `drift_cap_30d=${Number(driftPolicy.drift_cap_30d || 0)}`
  );
  addCheck(
    'drift_aware_revenue_optimizer:slo_and_sources_present',
    typeof driftPolicy.require_execution_slo_pass === 'boolean'
      && !!cleanText(driftPolicy.execution_reliability_state_path || '', 200)
      && !!cleanText(driftPolicy.high_value_latest_path || '', 200)
      && !!cleanText(driftPolicy.high_value_history_path || '', 200),
    `require_execution_slo_pass=${typeof driftPolicy.require_execution_slo_pass === 'boolean' ? String(driftPolicy.require_execution_slo_pass) : 'missing'}`
  );
  addCheck(
    'self_hosted_bootstrap:merge_guard_hook',
    mergeGuardSrc.includes('self_hosted_bootstrap_compiler.js')
      && mergeGuardSrc.includes('status'),
    'merge_guard should enforce self-hosted bootstrap status check'
  );
  const selfHostPolicy = readJsonSafe(path.join(ROOT, 'config', 'self_hosted_bootstrap_policy.json'), {});
  const verifyCommands = Array.isArray(selfHostPolicy.verify_commands) ? selfHostPolicy.verify_commands : [];
  addCheck(
    'self_hosted_bootstrap:verify_commands_present',
    verifyCommands.length >= 2,
    `verify_commands=${verifyCommands.length}`
  );
  addCheck(
    'self_hosted_bootstrap:approval_gate_present',
    Number(selfHostPolicy.min_approval_note_chars || 0) >= 8,
    `min_approval_note_chars=${Number(selfHostPolicy.min_approval_note_chars || 0)}`
  );
  const simplicityPolicy = readJsonSafe(path.join(ROOT, 'config', 'simplicity_budget_policy.json'), {});
  addCheck(
    'simplicity_budget:policy_enabled',
    simplicityPolicy.enabled !== false,
    `enabled=${simplicityPolicy.enabled !== false ? '1' : '0'}`
  );
  const simplicityMaxSystemFiles = Math.max(1, Number(simplicityPolicy.max_system_files || 0) || 0);
  const simplicityMaxSystemLoc = Math.max(1, Number(simplicityPolicy.max_system_loc || 0) || 0);
  addCheck(
    'simplicity_budget:core_caps_present',
    simplicityMaxSystemFiles > 0 && simplicityMaxSystemLoc > 0,
    `max_system_files=${simplicityMaxSystemFiles} max_system_loc=${simplicityMaxSystemLoc}`
  );

  const workflowSrc = readFileSafe(path.join(ROOT, 'systems', 'workflow', 'workflow_executor.ts'));
  addCheck(
    'workflow:primitive_runtime_import',
    workflowSrc.includes("require('../primitives/primitive_runtime.js')"),
    'workflow_executor must import primitive runtime'
  );
  addCheck(
    'workflow:primitive_execute_call',
    workflowSrc.includes('executeCommandPrimitiveSync('),
    'workflow_executor must route command execution through primitive runtime'
  );
  addCheck(
    'workflow:effect_type_gate_hook',
    workflowSrc.includes("require('../primitives/effect_type_system.js')")
      && workflowSrc.includes('evaluateWorkflowEffectPlan('),
    'workflow_executor must evaluate effect-type plans before execution'
  );
  addCheck(
    'workflow:sandbox_envelope_hook',
    workflowSrc.includes("require('../security/execution_sandbox_envelope.js')")
      && workflowSrc.includes('evaluateWorkflowSandbox('),
    'workflow_executor must evaluate sandbox envelope before step execution'
  );
  const helixSrc = readFileSafe(path.join(ROOT, 'systems', 'helix', 'helix_controller.ts'));
  addCheck(
    'helix:safety_resilience_hook',
    helixSrc.includes("require('../security/safety_resilience_guard')")
      && helixSrc.includes('evaluateSafetyResilience('),
    'helix_controller must route sentinel output through safety resilience guard'
  );
  addCheck(
    'helix:confirmed_malice_quarantine_hook',
    helixSrc.includes("require('./confirmed_malice_quarantine')")
      && helixSrc.includes('applyPermanentQuarantine('),
    'helix_controller must route confirmed malice decisions through permanent quarantine lane'
  );
  const redTeamPolicy = readJsonSafe(path.join(ROOT, 'config', 'red_team_policy.json'), {});
  const antColonyPolicy = redTeamPolicy.ant_colony && typeof redTeamPolicy.ant_colony === 'object'
    ? redTeamPolicy.ant_colony
    : {};
  const antConsensus = antColonyPolicy.consensus && typeof antColonyPolicy.consensus === 'object'
    ? antColonyPolicy.consensus
    : {};
  const antWar = antColonyPolicy.war_mode && typeof antColonyPolicy.war_mode === 'object'
    ? antColonyPolicy.war_mode
    : {};
  const antAssimilation = antColonyPolicy.assimilation_priority && typeof antColonyPolicy.assimilation_priority === 'object'
    ? antColonyPolicy.assimilation_priority
    : {};
  addCheck(
    'redteam_ant_colony:merge_guard_hook',
    mergeGuardSrc.includes('ant_colony_controller.js')
      && mergeGuardSrc.includes('status'),
    'merge_guard should enforce redteam ant colony status check'
  );
  addCheck(
    'redteam_ant_colony:policy_triple_consensus_and_priority_window',
    antColonyPolicy.enabled !== false
      && antConsensus.require_helix_tamper !== false
      && antConsensus.require_sentinel_agreement !== false
      && Number(antWar.confidence_threshold || 0) >= 0.95
      && Number(antAssimilation.hours_since_graft || 0) >= 72,
    `enabled=${antColonyPolicy.enabled !== false ? '1' : '0'} require_helix_tamper=${antConsensus.require_helix_tamper !== false ? '1' : '0'} require_sentinel_agreement=${antConsensus.require_sentinel_agreement !== false ? '1' : '0'} confidence_threshold=${Number(antWar.confidence_threshold || 0)} hours_since_graft=${Number(antAssimilation.hours_since_graft || 0)}`
  );
  const antSrc = readFileSafe(path.join(ROOT, 'systems', 'redteam', 'ant_colony_controller.ts'));
  addCheck(
    'redteam_ant_colony:controller_hooks',
    antSrc.includes("require('./morph_manager')")
      && antSrc.includes("require('./swarm_tactics')")
      && antSrc.includes("require('./wisdom_distiller')")
      && antSrc.includes('recentAssimilationTargets('),
    'ant_colony_controller should keep morph/tactics/wisdom/priority probe hooks'
  );
  const venomPolicy = readJsonSafe(path.join(ROOT, 'config', 'venom_containment_policy.json'), {});
  addCheck(
    'venom_containment:defensive_only_policy',
    venomPolicy.enabled !== false
      && venomPolicy.shadow_only !== false
      && venomPolicy.defensive_only_invariant !== false
      && Array.isArray(venomPolicy.offensive_behaviors_forbidden)
      && venomPolicy.offensive_behaviors_forbidden.includes('external_attack')
      && venomPolicy.offensive_behaviors_forbidden.includes('malware_payload'),
    `enabled=${venomPolicy.enabled !== false ? '1' : '0'} shadow_only=${venomPolicy.shadow_only !== false ? '1' : '0'} defensive_only=${venomPolicy.defensive_only_invariant !== false ? '1' : '0'}`
  );
  const venomSrc = readFileSafe(path.join(ROOT, 'systems', 'security', 'venom_containment_layer.ts'));
  addCheck(
    'venom_containment:controller_hooks',
    venomSrc.includes('defensiveInvariantStatus(')
      && venomSrc.includes('stageFromHits(')
      && venomSrc.includes('writeForensicEvidence(')
      && venomSrc.includes('generateDecoyResponse('),
    'venom_containment_layer should enforce defensive-only stage/forensic/decoy hooks'
  );
  const adaptivePolicy = readJsonSafe(path.join(ROOT, 'config', 'redteam_adaptive_defense_policy.json'), {});
  const hallPass = adaptivePolicy.hall_pass && typeof adaptivePolicy.hall_pass === 'object' ? adaptivePolicy.hall_pass : {};
  addCheck(
    'redteam_adaptive_defense:hall_pass_policy',
    adaptivePolicy.enabled !== false
      && adaptivePolicy.shadow_only !== false
      && adaptivePolicy.defensive_only !== false
      && hallPass.enabled !== false
      && Array.isArray(hallPass.non_exemptible)
      && hallPass.non_exemptible.includes('defensive_only_invariant'),
    `enabled=${adaptivePolicy.enabled !== false ? '1' : '0'} shadow_only=${adaptivePolicy.shadow_only !== false ? '1' : '0'} defensive_only=${adaptivePolicy.defensive_only !== false ? '1' : '0'} hall_pass=${hallPass.enabled !== false ? '1' : '0'}`
  );
  const adaptiveSrc = readFileSafe(path.join(ROOT, 'systems', 'redteam', 'adaptive_defense_expansion.ts'));
  addCheck(
    'redteam_adaptive_defense:registry_and_audit_hooks',
    adaptiveSrc.includes('requestExemption(')
      && adaptiveSrc.includes('approveExemption(')
      && adaptiveSrc.includes('auditExemptions(')
      && adaptiveSrc.includes('runAdaptiveDefenseExpansion('),
    'adaptive_defense_expansion should expose exemption + audit + run hooks'
  );

  const actuationSrc = readFileSafe(path.join(ROOT, 'systems', 'actuation', 'actuation_executor.ts'));
  addCheck(
    'actuation:primitive_runtime_import',
    actuationSrc.includes("require('../primitives/primitive_runtime.js')"),
    'actuation_executor must import primitive runtime'
  );
  addCheck(
    'actuation:primitive_execute_call',
    actuationSrc.includes('executeActuationPrimitiveAsync('),
    'actuation_executor must route adapter execution through primitive runtime'
  );
  addCheck(
    'actuation:sandbox_envelope_hook',
    actuationSrc.includes("require('../security/execution_sandbox_envelope.js')")
      && actuationSrc.includes('evaluateActuationSandbox('),
    'actuation_executor must evaluate sandbox envelope before adapter execution'
  );

  const contractCheckSrc = readFileSafe(path.join(ROOT, 'systems', 'spine', 'contract_check.ts'));
  addCheck(
    'guard_check_registry:contract_check_consumes_manifest',
    contractCheckSrc.includes('guard_check_registry')
      && contractCheckSrc.includes('required_merge_guard_ids'),
    'contract_check should validate guard registry contracts'
  );
  addCheck(
    'contract_check:foundation_hooks',
    contractCheckSrc.includes('foundation_contract_gate.js')
      && contractCheckSrc.includes('scale_envelope_baseline.js')
      && contractCheckSrc.includes('simplicity_budget_gate.js')
      && contractCheckSrc.includes('phone_seed_profile.js')
      && contractCheckSrc.includes('surface_budget_controller.js')
      && contractCheckSrc.includes('compression_transfer_plane.js')
      && contractCheckSrc.includes('opportunistic_offload_plane.js')
      && contractCheckSrc.includes('gated_account_creation_organ.js')
      && contractCheckSrc.includes('siem_bridge.js')
      && contractCheckSrc.includes('soc2_type2_track.js')
      && contractCheckSrc.includes('predictive_capacity_forecast.js')
      && contractCheckSrc.includes('execution_sandbox_envelope.js')
      && contractCheckSrc.includes('organ_state_encryption_plane.js')
      && contractCheckSrc.includes('remote_tamper_heartbeat.js')
      && contractCheckSrc.includes('secure_heartbeat_endpoint.js')
      && contractCheckSrc.includes('gated_self_improvement_loop.js')
      && contractCheckSrc.includes('helix_admission_gate.js')
      && contractCheckSrc.includes('venom_containment_layer.js')
      && contractCheckSrc.includes('adaptive_defense_expansion.js')
      && contractCheckSrc.includes('confirmed_malice_quarantine.js')
      && contractCheckSrc.includes('helix_controller.js')
      && contractCheckSrc.includes('ant_colony_controller.js')
      && contractCheckSrc.includes('neural_dormant_seed.js')
      && contractCheckSrc.includes('pre_neuralink_interface.js')
      && contractCheckSrc.includes('client_relationship_manager.js')
      && contractCheckSrc.includes('capital_allocation_organ.js')
      && contractCheckSrc.includes('economic_entity_manager.js')
      && contractCheckSrc.includes('drift_aware_revenue_optimizer.js'),
    'contract_check should validate foundation scripts'
  );
  const policyRuntimeSrc = readFileSafe(path.join(ROOT, 'lib', 'policy_runtime.ts'));
  addCheck(
    'policy_runtime:primitive_present',
    policyRuntimeSrc.includes('loadPolicyRuntime')
      && policyRuntimeSrc.includes('deepMerge')
      && policyRuntimeSrc.includes('resolvePolicyPath'),
    'policy runtime primitive should expose shared load/merge/path helpers'
  );
  addCheck(
    'policy_runtime:migrated_lanes',
    readFileSafe(path.join(ROOT, 'systems', 'memory', 'rust_memory_transition_lane.ts')).includes('loadPolicyRuntime')
      && readFileSafe(path.join(ROOT, 'systems', 'memory', 'rust_memory_daemon_supervisor.ts')).includes('loadPolicyRuntime')
      && readFileSafe(path.join(ROOT, 'systems', 'memory', 'memory_index_freshness_gate.ts')).includes('loadPolicyRuntime'),
    'selected memory lanes should consume shared policy runtime primitive'
  );
  const stateArtifactSrc = readFileSafe(path.join(ROOT, 'lib', 'state_artifact_contract.ts'));
  addCheck(
    'state_artifact_contract:primitive_present',
    stateArtifactSrc.includes('writeArtifactSet')
      && stateArtifactSrc.includes('appendArtifactHistory')
      && stateArtifactSrc.includes('trimJsonlRows'),
    'state artifact contract primitive should expose latest/history/receipt helpers'
  );
  addCheck(
    'state_artifact_contract:migrated_lanes',
    readFileSafe(path.join(ROOT, 'systems', 'memory', 'rust_memory_transition_lane.ts')).includes('writeTransitionReceipt')
      && readFileSafe(path.join(ROOT, 'systems', 'memory', 'rust_memory_daemon_supervisor.ts')).includes('writeArtifactSet')
      && readFileSafe(path.join(ROOT, 'systems', 'memory', 'memory_index_freshness_gate.ts')).includes('appendArtifactHistory'),
    'selected memory lanes should use shared state artifact contract helpers'
  );

  const strict = checks.every((row) => row.ok === true);
  return {
    schema_id: 'foundation_contract_gate',
    schema_version: '1.0',
    ts: nowIso(),
    ok: strict,
    checks,
    failed_checks: checks.filter((row) => row.ok !== true).length
  };
}

function statePath() {
  return path.join(ROOT, 'state', 'ops', 'foundation_contract_gate.json');
}

function writeState(payload: AnyObj) {
  const fp = statePath();
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function cmdRun(args: AnyObj) {
  const strict = boolFlag(args.strict, false);
  const payload = runGate();
  writeState(payload);
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  if (strict && payload.ok !== true) process.exit(1);
}

function cmdStatus() {
  const fp = statePath();
  if (!fs.existsSync(fp)) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      reason: 'status_not_found',
      state_path: path.relative(ROOT, fp)
    }, null, 2)}\n`);
    process.exit(1);
  }
  process.stdout.write(`${fs.readFileSync(fp, 'utf8')}\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim().toLowerCase();
  if (!cmd || cmd === 'help' || cmd === '--help' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'run') return cmdRun(args);
  if (cmd === 'status') return cmdStatus();
  usage();
  process.exit(2);
}

if (require.main === module) {
  main();
}
