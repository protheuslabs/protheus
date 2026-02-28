#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function writeFile(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text, 'utf8');
}

function writeJson(filePath, value) {
  writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function runNode(scriptPath, args, env, cwd) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd,
    env,
    encoding: 'utf8'
  });
}

function parseJsonStdout(proc) {
  const raw = String(proc.stdout || '').trim();
  assert.ok(raw, 'expected JSON stdout');
  return JSON.parse(raw);
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return String(fs.readFileSync(filePath, 'utf8') || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function assertOk(proc, label) {
  assert.strictEqual(proc.status, 0, `${label} failed: ${proc.stderr || proc.stdout}`);
  const out = parseJsonStdout(proc);
  assert.strictEqual(out.ok, true, `${label} expected ok=true`);
  return out;
}

function basePolicy() {
  return {
    version: '1.0-test',
    enabled: true,
    shadow_only: true,
    allow_apply: false,
    max_candidates_per_run: 6,
    trigger: {
      min_uses: 2,
      min_workflow_spread: 2,
      min_days_observed: 0,
      min_pain_score: 0,
      cooldown_after_failure_hours: 0,
      cooldown_after_rejection_hours: 0
    },
    legal_gate: {
      fail_closed: true,
      require_license_check: true,
      require_tos_check: true,
      require_robots_check: true,
      require_data_rights: true,
      denied_licenses: ['gpl-3.0'],
      allowed_licenses: [],
      blocked_domains: []
    },
    anti_gaming: {
      hidden_eval_min_cases: 3,
      hidden_eval_max_cases: 7,
      retry_rate_limit_per_capability_per_day: 10
    },
    risk_classes: {
      high_risk: ['payments', 'auth', 'filesystem', 'shell', 'network-control'],
      require_explicit_human_approval: true
    },
    assimilation_scope: {
      max_assimilation_depth: 2,
      approval_threshold_score: 0.7,
      resource_budget_gate: {
        enabled: false
      },
      atrophy: {
        enabled: true,
        dormant_after_days: 30,
        compression: 'zstd'
      }
    },
    research_probe: {
      min_confidence: 0.4
    },
    integration: {
      weaver_latest_path: 'state/autonomy/weaver/latest.json',
      nursery_shadow_only: true,
      adversarial_shadow_only: true,
      memory_evolution_enabled: true,
      context_navigation_enabled: true,
      generative_simulation_enabled: true,
      collective_reasoning_enabled: true,
      environment_evolution_enabled: true,
      test_time_memory_evolution_enabled: true,
      group_evolving_agents_enabled: true,
      generative_meta_model_enabled: true,
      self_teacher_distillation_enabled: true,
      adaptive_ensemble_routing_enabled: true,
      memory_evolution_policy_path: 'config/memory_evolution_primitive_policy.json',
      context_navigation_policy_path: 'config/context_navigation_primitive_policy.json',
      generative_simulation_policy_path: 'config/generative_simulation_mode_policy.json',
      collective_reasoning_policy_path: 'config/collective_reasoning_primitive_policy.json',
      environment_evolution_policy_path: 'config/environment_evolution_layer_policy.json',
      test_time_memory_evolution_policy_path: 'config/test_time_memory_evolution_primitive_policy.json',
      group_evolving_agents_policy_path: 'config/group_evolving_agents_primitive_policy.json',
      generative_meta_model_policy_path: 'config/generative_meta_model_primitive_policy.json',
      self_teacher_distillation_policy_path: 'config/self_teacher_distillation_primitive_policy.json',
      adaptive_ensemble_routing_policy_path: 'config/adaptive_ensemble_routing_primitive_policy.json',
      weaver_ensemble_profiles_path: 'state/autonomy/weaver/adaptive_ensemble_profiles.jsonl'
    },
    outputs: {
      emit_events: true,
      emit_ide_events: true,
      emit_obsidian_projection: true
    }
  };
}

function run() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const scriptPath = path.join(repoRoot, 'systems', 'assimilation', 'assimilation_controller.js');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'assimilation-controller-'));
  const policyPath = path.join(tmpRoot, 'config', 'assimilation_policy.json');
  const dualityPolicyPath = path.join(tmpRoot, 'config', 'duality_seed_policy.json');
  const dualityCodexPath = path.join(tmpRoot, 'config', 'duality_codex.txt');
  const capabilityProfilePolicyPath = path.join(tmpRoot, 'config', 'capability_profile_policy.json');
  const capabilityProfileSchemaPath = path.join(tmpRoot, 'config', 'capability_profile_schema.json');
  const capabilityProfileStateRoot = path.join(tmpRoot, 'state', 'assimilation', 'capability_profiles');
  const valueAttributionPolicyPath = path.join(tmpRoot, 'config', 'value_attribution_primitive_policy.json');
  const memoryEvolutionPolicyPath = path.join(tmpRoot, 'config', 'memory_evolution_primitive_policy.json');
  const contextNavigationPolicyPath = path.join(tmpRoot, 'config', 'context_navigation_primitive_policy.json');
  const generativeSimulationPolicyPath = path.join(tmpRoot, 'config', 'generative_simulation_mode_policy.json');
  const collectiveReasoningPolicyPath = path.join(tmpRoot, 'config', 'collective_reasoning_primitive_policy.json');
  const environmentEvolutionPolicyPath = path.join(tmpRoot, 'config', 'environment_evolution_layer_policy.json');
  const testTimeMemoryEvolutionPolicyPath = path.join(tmpRoot, 'config', 'test_time_memory_evolution_primitive_policy.json');
  const groupEvolvingAgentsPolicyPath = path.join(tmpRoot, 'config', 'group_evolving_agents_primitive_policy.json');
  const generativeMetaModelPolicyPath = path.join(tmpRoot, 'config', 'generative_meta_model_primitive_policy.json');
  const selfTeacherDistillationPolicyPath = path.join(tmpRoot, 'config', 'self_teacher_distillation_primitive_policy.json');
  const adaptiveEnsembleRoutingPolicyPath = path.join(tmpRoot, 'config', 'adaptive_ensemble_routing_primitive_policy.json');
  const valueAttributionRecordsPath = path.join(tmpRoot, 'state', 'assimilation', 'value_attribution', 'records.jsonl');
  const stateDir = path.join(tmpRoot, 'state', 'assimilation');
  const weaverLatestPath = path.join(tmpRoot, 'state', 'autonomy', 'weaver', 'latest.json');
  const weaverCollectivePath = path.join(tmpRoot, 'state', 'autonomy', 'weaver', 'collective_reasoning_profiles.jsonl');
  const weaverEnsemblePath = path.join(tmpRoot, 'state', 'autonomy', 'weaver', 'adaptive_ensemble_profiles.jsonl');

  writeJson(weaverLatestPath, {
    ts: new Date().toISOString(),
    veto_blocked: false,
    value_context: {
      constitutional_veto: {
        blocked: false
      },
      primary_metric_id: 'adaptive_value',
      value_currency: 'adaptive_value'
    }
  });
  writeJson(capabilityProfileSchemaPath, {
    schema_id: 'capability_profile',
    schema_version: '1.0',
    required_top_level: ['profile_id', 'schema_version', 'generated_at', 'source', 'surface', 'provenance'],
    required_source_fields: ['capability_id', 'source_type'],
    surface_contract: {
      required_sections: ['api', 'auth', 'rate_limit', 'error'],
      at_least_one_activity_field: ['api.endpoints', 'ui.flows']
    },
    provenance_required_fields: ['origin', 'legal', 'confidence'],
    allowed_source_types: ['local_skill', 'external_adapter', 'external_tool']
  });
  writeJson(capabilityProfilePolicyPath, {
    version: '1.0-test',
    enabled: true,
    strict_validation: true,
    schema_path: capabilityProfileSchemaPath,
    state: {
      root: capabilityProfileStateRoot,
      profiles_dir: path.join(capabilityProfileStateRoot, 'profiles'),
      receipts_path: path.join(capabilityProfileStateRoot, 'receipts.jsonl'),
      latest_path: path.join(capabilityProfileStateRoot, 'latest.json')
    },
    onboarding: {
      profile_only_path_enabled: true,
      require_provenance: true,
      max_profile_aliases: 64
    }
  });
  writeJson(valueAttributionPolicyPath, {
    version: '1.0-test',
    enabled: true,
    shadow_only: true,
    allow_apply: false,
    scoring: {
      default_weight: 1,
      default_confidence: 0.8,
      default_impact: 0.7
    },
    passport: {
      enabled: false,
      source: 'value_attribution_primitive'
    },
    helix: {
      enabled: true,
      events_path: path.join(tmpRoot, 'state', 'helix', 'events.jsonl')
    },
    state: {
      root: path.join(tmpRoot, 'state', 'assimilation', 'value_attribution'),
      records_path: valueAttributionRecordsPath,
      latest_path: path.join(tmpRoot, 'state', 'assimilation', 'value_attribution', 'latest.json'),
      history_path: path.join(tmpRoot, 'state', 'assimilation', 'value_attribution', 'history.jsonl'),
      receipts_path: path.join(tmpRoot, 'state', 'assimilation', 'value_attribution', 'receipts.jsonl')
    }
  });
  writeJson(memoryEvolutionPolicyPath, {
    schema_id: 'memory_evolution_primitive_policy',
    schema_version: '1.0-test',
    enabled: true,
    shadow_only: true,
    learning_rate: 0.3,
    discount_factor: 0.8,
    retrieval: {
      two_phase_enabled: false,
      max_recent_episodes: 40,
      max_graph_events: 0,
      require_capability_match: true
    },
    rewards: {
      success: 0.1,
      shadow_only: 0.01,
      reject: -0.08,
      fail: -0.2,
      environment_weight: 0.1,
      duality_weight: 0.1
    },
    doctor_feedback: {
      enabled: true,
      queue_path: path.join(tmpRoot, 'state', 'ops', 'autotest_doctor', 'memory_evolution_feedback.jsonl'),
      q_alert_threshold: -0.12
    },
    state: {
      root: path.join(tmpRoot, 'state', 'assimilation', 'memory_evolution'),
      q_values_path: path.join(tmpRoot, 'state', 'assimilation', 'memory_evolution', 'q_values.json'),
      episodes_path: path.join(tmpRoot, 'state', 'assimilation', 'memory_evolution', 'episodes.jsonl'),
      latest_path: path.join(tmpRoot, 'state', 'assimilation', 'memory_evolution', 'latest.json'),
      receipts_path: path.join(tmpRoot, 'state', 'assimilation', 'memory_evolution', 'receipts.jsonl'),
      causal_graph_state_path: path.join(tmpRoot, 'state', 'memory', 'causal_temporal_graph', 'state.json')
    }
  });
  writeJson(contextNavigationPolicyPath, {
    schema_id: 'context_navigation_primitive_policy',
    schema_version: '1.0-test',
    enabled: true,
    shadow_only: true,
    recursion: {
      max_depth: 3,
      max_segments_per_depth: 8,
      max_selected_segments: 12,
      min_relevance_score: 1
    },
    context: {
      max_chars_per_segment: 180,
      max_total_chars: 16000
    },
    state: {
      latest_path: path.join(tmpRoot, 'state', 'assimilation', 'context_navigation', 'latest.json'),
      receipts_path: path.join(tmpRoot, 'state', 'assimilation', 'context_navigation', 'receipts.jsonl')
    }
  });
  writeJson(generativeSimulationPolicyPath, {
    schema_id: 'generative_simulation_mode_policy',
    schema_version: '1.0-test',
    enabled: true,
    shadow_only: true,
    beta_stage_lock: {
      enabled: true,
      max_allowed_stage: 'months',
      locked_stages: ['years', 'decades', 'centuries']
    },
    scenarios: {
      count: 4,
      fail_if_drift_over: 0.65,
      fail_if_safety_under: 0.3,
      fail_if_yield_under: 0.1
    },
    stage_windows: {
      days: 7,
      weeks: 30,
      months: 120,
      years: 365,
      decades: 3650,
      centuries: 36500
    },
    state: {
      latest_path: path.join(tmpRoot, 'state', 'assimilation', 'generative_simulation', 'latest.json'),
      receipts_path: path.join(tmpRoot, 'state', 'assimilation', 'generative_simulation', 'receipts.jsonl')
    }
  });
  writeJson(collectiveReasoningPolicyPath, {
    schema_id: 'collective_reasoning_primitive_policy',
    schema_version: '1.0-test',
    enabled: true,
    shadow_only: true,
    quorum: {
      min_agents: 3,
      decision_threshold: 0.55
    },
    trust: {
      default_score: 0.6,
      min_score: 0.05,
      max_score: 0.99,
      positive_delta: 0.03,
      negative_delta: 0.06
    },
    delegation: {
      max_assignees: 3,
      preferred_lanes: ['autonomous_micro_agent', 'storm_human_lane', 'mirror_lane']
    },
    state: {
      latest_path: path.join(tmpRoot, 'state', 'assimilation', 'collective_reasoning', 'latest.json'),
      history_path: path.join(tmpRoot, 'state', 'assimilation', 'collective_reasoning', 'history.jsonl'),
      trust_ledger_path: path.join(tmpRoot, 'state', 'assimilation', 'collective_reasoning', 'trust_ledger.json'),
      receipts_path: path.join(tmpRoot, 'state', 'assimilation', 'collective_reasoning', 'receipts.jsonl')
    }
  });
  writeJson(environmentEvolutionPolicyPath, {
    schema_id: 'environment_evolution_layer_policy',
    schema_version: '1.0-test',
    enabled: true,
    shadow_only: true,
    ema_alpha: 0.22,
    robustness_thresholds: {
      strong: 0.7,
      weak: 0.35
    },
    feedback: {
      confidence_shaping_gain: 0.2,
      doctor_on_fail: true,
      min_samples_for_stability: 2
    },
    state: {
      state_path: path.join(tmpRoot, 'state', 'assimilation', 'environment_evolution', 'state.json'),
      latest_path: path.join(tmpRoot, 'state', 'assimilation', 'environment_evolution', 'latest.json'),
      receipts_path: path.join(tmpRoot, 'state', 'assimilation', 'environment_evolution', 'receipts.jsonl'),
      doctor_queue_path: path.join(tmpRoot, 'state', 'ops', 'autotest_doctor', 'environment_feedback_queue.jsonl')
    }
  });
  writeJson(testTimeMemoryEvolutionPolicyPath, {
    schema_id: 'test_time_memory_evolution_primitive_policy',
    schema_version: '1.0-test',
    enabled: true,
    shadow_only: true,
    search: {
      max_episode_candidates: 64,
      max_synthesized_insights: 6,
      novelty_bias: 0.3
    },
    evolution: {
      reward_gain: 0.2,
      penalty_gain: 0.2,
      decay: 0.94,
      target_step_reduction: 0.5,
      max_step_reduction: 0.85
    },
    state: {
      memory_graph_path: path.join(tmpRoot, 'state', 'assimilation', 'memory_evolution', 'episodes.jsonl'),
      state_path: path.join(tmpRoot, 'state', 'assimilation', 'test_time_memory_evolution', 'state.json'),
      latest_path: path.join(tmpRoot, 'state', 'assimilation', 'test_time_memory_evolution', 'latest.json'),
      receipts_path: path.join(tmpRoot, 'state', 'assimilation', 'test_time_memory_evolution', 'receipts.jsonl')
    }
  });
  writeJson(groupEvolvingAgentsPolicyPath, {
    schema_id: 'group_evolving_agents_primitive_policy',
    schema_version: '1.0-test',
    enabled: true,
    shadow_only: true,
    sharing: {
      max_peer_experiences: 24,
      min_reuse_confidence: 0.4,
      innovation_bonus: 0.2
    },
    trust: {
      min_peer_trust: 0.3,
      trust_decay: 0.95,
      trust_gain: 0.05,
      trust_penalty: 0.1
    },
    state: {
      pool_path: path.join(tmpRoot, 'state', 'assimilation', 'group_evolving_agents', 'pool.json'),
      latest_path: path.join(tmpRoot, 'state', 'assimilation', 'group_evolving_agents', 'latest.json'),
      receipts_path: path.join(tmpRoot, 'state', 'assimilation', 'group_evolving_agents', 'receipts.jsonl')
    }
  });
  writeJson(generativeMetaModelPolicyPath, {
    schema_id: 'generative_meta_model_primitive_policy',
    schema_version: '1.0-test',
    enabled: true,
    shadow_only: true,
    manifold: {
      ema_alpha: 0.3,
      max_vector_dims: 24,
      max_steering_magnitude: 0.4,
      steering_gain: 0.4
    },
    safety: {
      fluency_floor: 0.2,
      stability_floor: 0.2,
      clamp_distance: 5
    },
    state: {
      manifold_state_path: path.join(tmpRoot, 'state', 'assimilation', 'generative_meta_model', 'manifold_state.json'),
      latest_path: path.join(tmpRoot, 'state', 'assimilation', 'generative_meta_model', 'latest.json'),
      receipts_path: path.join(tmpRoot, 'state', 'assimilation', 'generative_meta_model', 'receipts.jsonl')
    }
  });
  writeJson(selfTeacherDistillationPolicyPath, {
    schema_id: 'self_teacher_distillation_primitive_policy',
    schema_version: '1.0-test',
    enabled: true,
    shadow_only: true,
    trajectories: {
      min_quality: 0.5,
      max_samples: 24,
      success_bonus: 0.08
    },
    distillation: {
      learning_rate: 0.2,
      apply_gain_cap: 0.3,
      acceptance_threshold: 0.5
    },
    state: {
      ledger_path: path.join(tmpRoot, 'state', 'assimilation', 'self_teacher_distillation', 'ledger.json'),
      latest_path: path.join(tmpRoot, 'state', 'assimilation', 'self_teacher_distillation', 'latest.json'),
      receipts_path: path.join(tmpRoot, 'state', 'assimilation', 'self_teacher_distillation', 'receipts.jsonl')
    }
  });
  writeJson(adaptiveEnsembleRoutingPolicyPath, {
    schema_id: 'adaptive_ensemble_routing_primitive_policy',
    schema_version: '1.0-test',
    enabled: true,
    shadow_only: true,
    routing: {
      min_specialists: 2,
      aligned_weight: 0.56,
      complementary_weight: 0.44,
      uncertainty_bias: 0.65,
      max_selected_specialists: 3
    },
    outputs: {
      emit_weaver_profile: true
    },
    state: {
      latest_path: path.join(tmpRoot, 'state', 'assimilation', 'adaptive_ensemble_routing', 'latest.json'),
      history_path: path.join(tmpRoot, 'state', 'assimilation', 'adaptive_ensemble_routing', 'history.jsonl'),
      receipts_path: path.join(tmpRoot, 'state', 'assimilation', 'adaptive_ensemble_routing', 'receipts.jsonl'),
      weaver_profiles_path: weaverEnsemblePath
    }
  });
  const policy = basePolicy();
  policy.integration.memory_evolution_policy_path = memoryEvolutionPolicyPath;
  policy.integration.context_navigation_policy_path = contextNavigationPolicyPath;
  policy.integration.generative_simulation_policy_path = generativeSimulationPolicyPath;
  policy.integration.collective_reasoning_policy_path = collectiveReasoningPolicyPath;
  policy.integration.environment_evolution_policy_path = environmentEvolutionPolicyPath;
  policy.integration.test_time_memory_evolution_policy_path = testTimeMemoryEvolutionPolicyPath;
  policy.integration.group_evolving_agents_policy_path = groupEvolvingAgentsPolicyPath;
  policy.integration.generative_meta_model_policy_path = generativeMetaModelPolicyPath;
  policy.integration.self_teacher_distillation_policy_path = selfTeacherDistillationPolicyPath;
  policy.integration.adaptive_ensemble_routing_policy_path = adaptiveEnsembleRoutingPolicyPath;
  policy.integration.weaver_ensemble_profiles_path = weaverEnsemblePath;
  writeJson(policyPath, policy);
  writeFile(dualityCodexPath, [
    '[meta]',
    'version=1.0-test',
    '',
    '[flux_pairs]',
    'order|chaos|yin_attrs=structure,stability|yang_attrs=exploration,novelty'
  ].join('\n'));
  writeJson(dualityPolicyPath, {
    version: '1.0-test',
    enabled: true,
    shadow_only: true,
    advisory_only: true,
    codex_path: dualityCodexPath,
    state: {
      latest_path: path.join(tmpRoot, 'state', 'autonomy', 'duality', 'latest.json'),
      history_path: path.join(tmpRoot, 'state', 'autonomy', 'duality', 'history.jsonl')
    },
    integration: {
      assimilation_candidacy: true
    }
  });

  const env = {
    ...process.env,
    ASSIMILATION_POLICY_PATH: policyPath,
    ASSIMILATION_STATE_DIR: stateDir,
    ASSIMILATION_WEAVER_LATEST_PATH: weaverLatestPath,
    ASSIMILATION_WEAVER_COLLECTIVE_PATH: weaverCollectivePath,
    ASSIMILATION_WEAVER_ENSEMBLE_PATH: weaverEnsemblePath,
    CAPABILITY_PROFILE_POLICY_PATH: capabilityProfilePolicyPath,
    DUALITY_SEED_POLICY_PATH: dualityPolicyPath,
    VALUE_ATTRIBUTION_POLICY_PATH: valueAttributionPolicyPath
  };

  // Unified candidacy ledger must accept both local skills and external adapters.
  assertOk(runNode(scriptPath, [
    'record-use',
    '--capability-id=cap.local.alpha',
    '--source-type=local_skill',
    '--workflow-id=wf_local_a',
    '--success=1',
    '--pain-score=0.2',
    '--license=mit',
    '--tos-ok=1',
    '--robots-ok=1',
    '--data-rights-ok=1'
  ], env, repoRoot), 'record local alpha #1');
  assertOk(runNode(scriptPath, [
    'record-use',
    '--capability-id=cap.local.alpha',
    '--source-type=local_skill',
    '--workflow-id=wf_local_b',
    '--success=1',
    '--pain-score=0.2',
    '--license=mit',
    '--tos-ok=1',
    '--robots-ok=1',
    '--data-rights-ok=1'
  ], env, repoRoot), 'record local alpha #2');

  assertOk(runNode(scriptPath, [
    'record-use',
    '--capability-id=cap.external.beta',
    '--source-type=external_adapter',
    '--workflow-id=wf_ext_a',
    '--success=1',
    '--pain-score=0.2',
    '--license=mit',
    '--tos-ok=1',
    '--robots-ok=1',
    '--data-rights-ok=1'
  ], env, repoRoot), 'record external beta #1');
  assertOk(runNode(scriptPath, [
    'record-use',
    '--capability-id=cap.external.beta',
    '--source-type=external_adapter',
    '--workflow-id=wf_ext_b',
    '--success=1',
    '--pain-score=0.2',
    '--license=mit',
    '--tos-ok=1',
    '--robots-ok=1',
    '--data-rights-ok=1'
  ], env, repoRoot), 'record external beta #2');

  const assess = assertOk(runNode(scriptPath, ['assess'], env, repoRoot), 'assess');
  const readyIds = new Set((assess.candidates || []).map((row) => String(row.capability_id || '')));
  assert.ok(readyIds.has('cap.local.alpha'), 'local skill candidate should be ready');
  assert.ok(readyIds.has('cap.external.beta'), 'external adapter candidate should be ready');

  const runShadow = assertOk(runNode(scriptPath, [
    'run',
    '2026-02-26',
    '--apply=1'
  ], env, repoRoot), 'run shadow');
  assert.ok((runShadow.candidates || []).length >= 2, 'shadow run should process ready candidates');
  for (const row of runShadow.candidates || []) {
    assert.strictEqual(row.outcome, 'shadow_only', 'shadow mode should not execute live graft');
    assert.strictEqual(row.graft.apply_executed, false, 'shadow mode should keep apply_executed=false');
    assert.ok(
      row.forge_replica && row.forge_replica.strand_candidate,
      'forge replica should include helix strand candidate'
    );
    assert.ok(
      row.graft && row.graft.helix_admission && row.graft.helix_admission.allowed === true,
      'graft should include helix admission decision'
    );
    assert.ok(
      row.capability_profile && row.capability_profile.ok === true,
      'capability profile should compile for ready candidates'
    );
    assert.ok(
      row.context_navigation && row.context_navigation.ok === true,
      'context navigation primitive should run for candidates'
    );
    assert.ok(
      row.collective_reasoning && row.collective_reasoning.ok === true,
      'collective reasoning primitive should run for candidates'
    );
    assert.ok(
      row.generative_simulation && row.generative_simulation.ok === true,
      'generative simulation mode should run for candidates'
    );
    assert.ok(
      row.generative_meta_model && row.generative_meta_model.ok === true,
      'generative meta-model primitive should run for candidates'
    );
    assert.ok(
      row.adaptive_ensemble_routing && row.adaptive_ensemble_routing.ok === true,
      'adaptive ensemble routing primitive should run for candidates'
    );
    assert.ok(
      row.environment_evolution && row.environment_evolution.ok === true,
      'environment evolution layer should run for candidates'
    );
    assert.ok(
      row.memory_evolution && row.memory_evolution.ok === true,
      'memory evolution primitive should run for candidates'
    );
    assert.ok(
      row.test_time_memory_evolution && row.test_time_memory_evolution.ok === true,
      'test-time memory evolution primitive should run for candidates'
    );
    assert.ok(
      row.self_teacher_distillation && row.self_teacher_distillation.ok === true,
      'self-teacher distillation primitive should run for candidates'
    );
    assert.ok(
      row.group_evolving_agents && row.group_evolving_agents.ok === true,
      'group-evolving agents primitive should run for candidates'
    );
    assert.ok(
      row.value_attribution && row.value_attribution.attribution_id,
      'candidate should include value attribution linkage'
    );
    assert.ok(row.duality && typeof row.duality.enabled === 'boolean', 'candidate should include duality advisory');
  }

  const attributionRows = readJsonl(valueAttributionRecordsPath);
  assert.ok(
    attributionRows.length >= Number(runShadow.candidates_processed || 0),
    'assimilation run should emit value attribution rows for processed candidates'
  );

  const ledgerPath = path.join(stateDir, 'ledger.json');
  const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
  assert.strictEqual(ledger.capabilities['cap.local.alpha'].source_type, 'local_skill');
  assert.strictEqual(ledger.capabilities['cap.external.beta'].source_type, 'external_adapter');
  const collectiveProfiles = readJsonl(weaverCollectivePath);
  assert.ok(collectiveProfiles.length >= 2, 'collective profiles should be emitted for weaver integration');
  const ensembleProfiles = readJsonl(weaverEnsemblePath);
  assert.ok(ensembleProfiles.length >= 2, 'ensemble routing profiles should be emitted for weaver integration');

  // Move to live-eligible mode and validate high-risk approval gating.
  const livePolicy = basePolicy();
  livePolicy.shadow_only = false;
  livePolicy.allow_apply = true;
  livePolicy.integration.memory_evolution_policy_path = memoryEvolutionPolicyPath;
  livePolicy.integration.context_navigation_policy_path = contextNavigationPolicyPath;
  livePolicy.integration.generative_simulation_policy_path = generativeSimulationPolicyPath;
  livePolicy.integration.collective_reasoning_policy_path = collectiveReasoningPolicyPath;
  livePolicy.integration.environment_evolution_policy_path = environmentEvolutionPolicyPath;
  livePolicy.integration.test_time_memory_evolution_policy_path = testTimeMemoryEvolutionPolicyPath;
  livePolicy.integration.group_evolving_agents_policy_path = groupEvolvingAgentsPolicyPath;
  livePolicy.integration.generative_meta_model_policy_path = generativeMetaModelPolicyPath;
  livePolicy.integration.self_teacher_distillation_policy_path = selfTeacherDistillationPolicyPath;
  livePolicy.integration.adaptive_ensemble_routing_policy_path = adaptiveEnsembleRoutingPolicyPath;
  livePolicy.integration.weaver_ensemble_profiles_path = weaverEnsemblePath;
  writeJson(policyPath, livePolicy);

  assertOk(runNode(scriptPath, [
    'record-use',
    '--capability-id=cap.external.shell',
    '--source-type=external_tool',
    '--risk-class=shell',
    '--workflow-id=wf_shell_a',
    '--success=1',
    '--pain-score=0.3',
    '--license=mit',
    '--tos-ok=1',
    '--robots-ok=1',
    '--data-rights-ok=1'
  ], env, repoRoot), 'record shell #1');
  assertOk(runNode(scriptPath, [
    'record-use',
    '--capability-id=cap.external.shell',
    '--source-type=external_tool',
    '--risk-class=shell',
    '--workflow-id=wf_shell_b',
    '--success=1',
    '--pain-score=0.3',
    '--license=mit',
    '--tos-ok=1',
    '--robots-ok=1',
    '--data-rights-ok=1'
  ], env, repoRoot), 'record shell #2');

  const runRejected = assertOk(runNode(scriptPath, [
    'run',
    '2026-02-26',
    '--capability-id=cap.external.shell',
    '--apply=1'
  ], env, repoRoot), 'run high risk unapproved');
  assert.strictEqual(runRejected.candidates.length, 1);
  assert.strictEqual(runRejected.candidates[0].outcome, 'reject');
  assert.ok(
    (runRejected.candidates[0].graft.reason_codes || []).includes('graft_blocked_high_risk_requires_human_approval'),
    'high-risk capability should require human approval'
  );

  const runApproved = assertOk(runNode(scriptPath, [
    'run',
    '2026-02-26',
    '--capability-id=cap.external.shell',
    '--apply=1',
    '--human-approved=1'
  ], env, repoRoot), 'run high risk approved');
  assert.strictEqual(runApproved.candidates.length, 1);
  assert.strictEqual(runApproved.candidates[0].outcome, 'success');
  assert.strictEqual(runApproved.candidates[0].graft.apply_executed, true);
  assert.ok(
    runApproved.candidates[0].graft.helix_admission
      && runApproved.candidates[0].graft.helix_admission.apply_executed === true,
    'approved live graft should execute helix admission apply path'
  );

  const status = assertOk(runNode(scriptPath, ['status', 'latest'], env, repoRoot), 'status latest');
  assert.ok(Number(status.candidates_processed || 0) >= 1, 'status should include processed count');
  assert.strictEqual(status.shadow_only, false, 'latest status should reflect live policy');

  console.log('assimilation_controller.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`assimilation_controller.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
