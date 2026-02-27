#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');

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

function runGate() {
  const checks: AnyObj[] = [];
  const addCheck = (id: string, ok: boolean, detail: string) => {
    checks.push({ id, ok: ok === true, detail: cleanText(detail, 400) });
  };

  const requiredFiles = [
    'config/abstraction_debt_baseline.json',
    'config/causal_temporal_memory_policy.json',
    'config/capital_allocation_policy.json',
    'config/client_relationship_manager_policy.json',
    'config/compression_transfer_plane_policy.json',
    'config/opportunistic_offload_policy.json',
    'config/drift_aware_revenue_optimizer_policy.json',
    'config/deterministic_control_plane_policy.json',
    'config/emergent_primitive_synthesis_policy.json',
    'config/effect_type_policy.json',
    'config/embodiment_layer_policy.json',
    'config/execution_sandbox_envelope_policy.json',
    'config/explanation_primitive_policy.json',
    'config/formal_invariants.json',
    'config/phone_seed_profile_policy.json',
    'config/predictive_capacity_forecast_policy.json',
    'config/neural_dormant_seed_policy.json',
    'config/organ_state_encryption_policy.json',
    'config/remote_tamper_heartbeat_policy.json',
    'config/crypto_agility_contract.json',
    'config/key_lifecycle_policy.json',
    'config/delegated_authority_policy.json',
    'config/continuous_chaos_resilience_policy.json',
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
    'config/siem_bridge_policy.json',
    'config/soc2_type2_policy.json',
    'config/surface_budget_controller_policy.json',
    'config/value_anchor_renewal_policy.json',
    'config/world_model_freshness_policy.json',
    'systems/ops/profile_compatibility_gate.ts',
    'systems/ops/simplicity_budget_gate.ts',
    'systems/ops/schema_evolution_contract.ts',
    'systems/continuity/resurrection_protocol.ts',
    'systems/echo/value_anchor_renewal.ts',
    'systems/memory/causal_temporal_graph.ts',
    'systems/distributed/deterministic_control_plane.ts',
    'systems/hardware/embodiment_layer.ts',
    'systems/hardware/compression_transfer_plane.ts',
    'systems/hardware/surface_budget_controller.ts',
    'systems/hardware/opportunistic_offload_plane.ts',
    'systems/budget/capital_allocation_organ.ts',
    'systems/weaver/drift_aware_revenue_optimizer.ts',
    'systems/workflow/client_relationship_manager.ts',
    'systems/primitives/effect_type_system.ts',
    'systems/primitives/emergent_primitive_synthesis.ts',
    'systems/primitives/explanation_primitive.ts',
    'systems/primitives/runtime_scheduler.ts',
    'systems/security/formal_invariant_engine.ts',
    'systems/security/execution_sandbox_envelope.ts',
    'systems/security/organ_state_encryption_plane.ts',
    'systems/security/remote_tamper_heartbeat.ts',
    'systems/security/key_lifecycle_governor.ts',
    'systems/security/delegated_authority_branching.ts',
    'systems/security/safety_resilience_guard.ts',
    'systems/assimilation/world_model_freshness.ts',
    'systems/observability/siem_bridge.ts',
    'systems/ops/continuous_chaos_resilience.ts',
    'systems/ops/soc2_type2_track.ts',
    'systems/ops/phone_seed_profile.ts',
    'systems/ops/predictive_capacity_forecast.ts',
    'systems/symbiosis/neural_dormant_seed.ts',
    'research/neural_dormant_seed/README.md',
    'research/neural_dormant_seed/governance_checklist.md',
    'systems/ops/self_hosted_bootstrap_compiler.ts',
    'systems/primitives/primitive_runtime.ts',
    'systems/primitives/policy_vm.ts',
    'systems/primitives/replay_verify.ts'
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
  const keyLifecyclePolicy = readJsonSafe(path.join(ROOT, 'config', 'key_lifecycle_policy.json'), {});
  const keyAllowedAlgorithms = Array.isArray(keyLifecyclePolicy.allowed_algorithms)
    ? keyLifecyclePolicy.allowed_algorithms.map((row: unknown) => normalizeLowerToken(row, 80)).filter(Boolean)
    : [];
  addCheck(
    'key_lifecycle:post_quantum_track_present',
    keyAllowedAlgorithms.includes('pq-dilithium3'),
    `allowed_algorithms=${keyAllowedAlgorithms.join(',')}`
  );
  const mergeGuardSrc = readFileSafe(path.join(ROOT, 'systems', 'security', 'merge_guard.ts'));
  addCheck(
    'formal_invariant_engine:merge_guard_hook',
    mergeGuardSrc.includes('formal_invariant_engine.js') && mergeGuardSrc.includes('--strict=1'),
    'merge_guard should enforce formal invariant engine'
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
    'key_lifecycle:merge_guard_hook',
    mergeGuardSrc.includes('key_lifecycle_governor.js')
      && mergeGuardSrc.includes('verify')
      && mergeGuardSrc.includes('--strict=1'),
    'merge_guard should enforce key lifecycle verification'
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
    'contract_check:foundation_hooks',
    contractCheckSrc.includes('foundation_contract_gate.js')
      && contractCheckSrc.includes('scale_envelope_baseline.js')
      && contractCheckSrc.includes('simplicity_budget_gate.js')
      && contractCheckSrc.includes('phone_seed_profile.js')
      && contractCheckSrc.includes('surface_budget_controller.js')
      && contractCheckSrc.includes('compression_transfer_plane.js')
      && contractCheckSrc.includes('opportunistic_offload_plane.js')
      && contractCheckSrc.includes('siem_bridge.js')
      && contractCheckSrc.includes('soc2_type2_track.js')
      && contractCheckSrc.includes('predictive_capacity_forecast.js')
      && contractCheckSrc.includes('execution_sandbox_envelope.js')
      && contractCheckSrc.includes('organ_state_encryption_plane.js')
      && contractCheckSrc.includes('remote_tamper_heartbeat.js')
      && contractCheckSrc.includes('neural_dormant_seed.js')
      && contractCheckSrc.includes('client_relationship_manager.js')
      && contractCheckSrc.includes('capital_allocation_organ.js')
      && contractCheckSrc.includes('drift_aware_revenue_optimizer.js'),
    'contract_check should validate foundation scripts'
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
