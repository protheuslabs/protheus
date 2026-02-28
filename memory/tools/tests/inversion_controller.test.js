#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function readJson(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function runNode(scriptPath, args, env, cwd) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd,
    env,
    encoding: 'utf8'
  });
}

function parseStdoutJson(proc) {
  const raw = String(proc.stdout || '').trim();
  assert.ok(raw, 'expected stdout payload');
  try {
    return JSON.parse(raw);
  } catch {}
  const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  throw new Error('unable to parse json output');
}

function run() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const scriptPath = path.join(repoRoot, 'systems', 'autonomy', 'inversion_controller.js');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'inversion-controller-'));
  const stateDir = path.join(tmpRoot, 'state', 'autonomy', 'inversion');
  const policyPath = path.join(tmpRoot, 'config', 'inversion_policy.json');
  const dualityPolicyPath = path.join(tmpRoot, 'config', 'duality_seed_policy.json');
  const dualityCodexPath = path.join(tmpRoot, 'config', 'duality_codex.txt');
  const regimeLatestPath = path.join(tmpRoot, 'state', 'autonomy', 'fractal', 'regime', 'latest.json');
  const mirrorLatestPath = path.join(tmpRoot, 'state', 'autonomy', 'mirror_organ', 'latest.json');
  const simulationDir = path.join(tmpRoot, 'state', 'autonomy', 'simulations');
  const redTeamRunsDir = path.join(tmpRoot, 'state', 'security', 'red_team', 'runs');
  const driftGovernorPath = path.join(tmpRoot, 'state', 'autonomy', 'drift_target_governor_state.json');

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    shadow_mode: true,
    runtime: {
      mode: 'live',
      test: {
        allow_constitution_inversion: true
      }
    },
    maturity: {
      target_test_count: 10,
      score_weights: {
        pass_rate: 0.5,
        non_destructive_rate: 0.35,
        experience: 0.15
      },
      bands: {
        novice: 0.25,
        developing: 0.45,
        mature: 0.65,
        seasoned: 0.82
      },
      max_target_rank_by_band: {
        novice: 1,
        developing: 2,
        mature: 2,
        seasoned: 3,
        legendary: 4
      }
    },
    impact: {
      max_target_rank: {
        low: 1,
        medium: 2,
        high: 3,
        critical: 4
      }
    },
    certainty_gate: {
      allow_zero_for_legendary_critical: true,
      thresholds: {
        novice: { low: 0.82, medium: 0.9, high: 0.96, critical: 0.98 },
        developing: { low: 0.72, medium: 0.82, high: 0.9, critical: 0.94 },
        mature: { low: 0.55, medium: 0.68, high: 0.8, critical: 0.88 },
        seasoned: { low: 0.38, medium: 0.52, high: 0.66, critical: 0.76 },
        legendary: { low: 0.4, medium: 0.75, high: 0.8, critical: 0 }
      }
    },
    targets: {
      tactical: { rank: 1, live_enabled: true, test_enabled: true, require_human_veto_live: false, min_shadow_hours: 0 },
      belief: { rank: 2, live_enabled: true, test_enabled: true, require_human_veto_live: false, min_shadow_hours: 6 },
      identity: { rank: 3, live_enabled: true, test_enabled: true, require_human_veto_live: true, min_shadow_hours: 24 },
      directive: { rank: 4, live_enabled: false, test_enabled: true, require_human_veto_live: true, min_shadow_hours: 72 },
      constitution: { rank: 4, live_enabled: false, test_enabled: true, require_human_veto_live: true, min_shadow_hours: 96 }
    },
    tier_transition: {
      enabled: true,
      human_veto_min_target_rank: 2,
      use_success_counts_for_first_n: true,
      first_live_uses_require_human_veto: {
        tactical: 0,
        belief: 2,
        identity: 4,
        directive: 8,
        constitution: 9999
      }
    },
    shadow_pass_gate: {
      enabled: true,
      require_for_live_apply: true,
      required_passes_by_target: {
        tactical: 0,
        belief: 1,
        identity: 2,
        directive: 2,
        constitution: 4
      },
      max_critical_failures_by_target: {
        tactical: 1,
        belief: 0,
        identity: 0,
        directive: 0,
        constitution: 0
      }
    },
    immutable_axioms: {
      enabled: true,
      axioms: [
        { id: 'preserve_root_constitution', patterns: ['disable constitution', 'rewrite constitution'] },
        { id: 'preserve_user_sovereignty', patterns: ['remove user control', 'bypass user veto'] }
      ]
    },
    creative_preference: {
      enabled: true,
      preferred_creative_lane_ids: ['creative_lane'],
      non_creative_certainty_penalty: 0.1
    },
    guardrails: {
      default_session_ttl_minutes: 180,
      max_active_sessions: 16,
      objective_id_required_min_target_rank: 4,
      max_similar_failures_by_band: {
        novice: 1,
        developing: 2,
        mature: 3,
        seasoned: 5,
        legendary: 8
      }
    },
    library: {
      max_entries: 500,
      min_similarity_for_reuse: 0.35,
      token_weight: 0.6,
      trit_weight: 0.3,
      target_weight: 0.1,
      failed_repetition_similarity_block: 0.95
    },
    first_principles: {
      enabled: true,
      auto_extract_on_success: true,
      max_strategy_bonus: 0.12,
      allow_failure_cluster_extraction: true,
      failure_cluster_min: 4,
      anti_downgrade: {
        enabled: true,
        require_same_or_higher_maturity: true,
        prevent_lower_confidence_same_band: true,
        same_band_confidence_floor_ratio: 0.92
      }
    },
    maturity_harness: {
      enabled: true,
      auto_trigger_on_run: false,
      trigger_interval_hours: 24,
      max_tests_per_cycle: 2,
      destructive_tokens: ['harm_human', 'disable_guard'],
      runtime_probes: {
        enabled: false,
        required: false
      },
      test_suite: [
        { id: 'imh-01', objective: 'test objective one', impact: 'medium', target: 'belief', difficulty: 'easy' },
        { id: 'imh-02', objective: 'test objective two', impact: 'high', target: 'identity', difficulty: 'hard' }
      ]
    },
    attractor: {
      enabled: true,
      min_alignment_by_target: {
        tactical: 0.1,
        belief: 0.1,
        identity: 0.15,
        directive: 0.2,
        constitution: 0.2
      },
      weights: {
        objective_specificity: 0.35,
        certainty: 0.25,
        trit_alignment: 0.2,
        impact_alignment: 0.2
      }
    },
    organ: {
      enabled: true,
      trigger_detection: {
        enabled: true,
        min_impossibility_score: 0.58,
        min_signal_count: 2,
        weights: {
          trit_pain: 0.2,
          mirror_pressure: 0.2,
          predicted_drift: 0.18,
          predicted_yield_gap: 0.18,
          red_team_critical: 0.14,
          regime_constrained: 0.1
        },
        thresholds: {
          predicted_drift_warn: 0.03,
          predicted_yield_warn: 0.68
        },
        paths: {
          regime_latest_path: regimeLatestPath,
          mirror_latest_path: mirrorLatestPath,
          simulation_dir: simulationDir,
          red_team_runs_dir: redTeamRunsDir,
          drift_governor_path: driftGovernorPath
        }
      },
      tree_search: {
        enabled: true,
        max_depth: 3,
        branch_factor: 5,
        max_candidates: 16,
        llm_enabled: false,
        llm_timeout_ms: 5000,
        max_llm_candidates: 6,
        desired_outcome_hint: 'connect impossible objective to a safe measurable path'
      },
      trials: {
        enabled: true,
        max_parallel_trials: 4,
        max_iterations: 2,
        min_trial_score: 0.2,
        allow_iterative_retries: true,
        require_runtime_probes: false,
        score_weights: {
          decision_allowed: 0.35,
          attractor: 0.2,
          certainty_margin: 0.15,
          library_similarity: 0.1,
          runtime_probe: 0.2
        }
      },
      visualization: {
        emit_tree_events: true,
        emit_trial_events: true
      }
    },
    output_interfaces: {
      default_channel: 'strategy_hint',
      belief_update: { enabled: true, live_enabled: true, test_enabled: true },
      strategy_hint: { enabled: true, live_enabled: true, test_enabled: true },
      workflow_hint: { enabled: true, live_enabled: true, test_enabled: true },
      code_change_proposal: { enabled: false, live_enabled: false, test_enabled: true, require_sandbox_verification: true }
    },
    telemetry: {
      emit_events: true,
      max_reasons: 12
    }
  });
  fs.mkdirSync(path.dirname(dualityCodexPath), { recursive: true });
  fs.writeFileSync(dualityCodexPath, [
    '[meta]',
    'version=1.0-test',
    '',
    '[flux_pairs]',
    'order|chaos|yin_attrs=structure,stability|yang_attrs=exploration,novelty'
  ].join('\n'), 'utf8');
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
      inversion_trigger: true
    }
  });

  const env = {
    ...process.env,
    INVERSION_STATE_DIR: stateDir,
    DUALITY_SEED_POLICY_PATH: dualityPolicyPath
  };

  // Build maturity to legendary quickly.
  for (let i = 0; i < 10; i += 1) {
    const rec = runNode(scriptPath, ['record-test', '--result=pass', `--policy=${policyPath}`], env, repoRoot);
    assert.strictEqual(rec.status, 0, rec.stderr || 'record-test should pass');
  }

  const statusAfterTests = runNode(scriptPath, ['status', `--policy=${policyPath}`], env, repoRoot);
  assert.strictEqual(statusAfterTests.status, 0, statusAfterTests.stderr || 'status should pass');
  const statusPayload = parseStdoutJson(statusAfterTests);
  assert.strictEqual(statusPayload.ok, true);
  assert.strictEqual(statusPayload.maturity.band, 'legendary');

  // Organ trigger detection + search tree + trials should run when impossibility signals are present.
  writeJson(regimeLatestPath, {
    selected_regime: 'defensive_constrained',
    candidate_confidence: 0.81,
    context: { trit: { trit: -1 } }
  });
  writeJson(mirrorLatestPath, {
    pressure_score: 0.84,
    confidence: 0.78,
    reasons: ['persistent_no_progress', 'safety_margin_pressure']
  });
  writeJson(path.join(simulationDir, '2026-02-26.json'), {
    checks_effective: {
      drift_rate: { value: 0.09 },
      yield_rate: { value: 0.41 }
    }
  });
  writeJson(path.join(redTeamRunsDir, '2026-02-26.json'), {
    summary: {
      critical_fail_cases: 1,
      pass_cases: 0,
      fail_cases: 1
    }
  });
  writeJson(driftGovernorPath, {
    last_decision: {
      trit_shadow: {
        belief: { trit: -1 }
      }
    }
  });

  const organRun = runNode(
    scriptPath,
    [
      'organ',
      '2026-02-26',
      '--objective=Recover impossible queue objective under strict safety constraints',
      '--objective-id=organ_probe_01',
      '--impact=high',
      '--target=belief',
      '--certainty=0.92',
      '--trit=-1',
      `--policy=${policyPath}`
    ],
    env,
    repoRoot
  );
  assert.strictEqual(organRun.status, 0, organRun.stderr || 'organ run should return payload');
  const organPayload = parseStdoutJson(organRun);
  assert.strictEqual(organPayload.ok, true);
  assert.strictEqual(organPayload.type, 'inversion_organ');
  assert.strictEqual(organPayload.triggered, true, JSON.stringify(organPayload.trigger || {}, null, 2));
  assert.ok(Number(organPayload.trigger && organPayload.trigger.score || 0) >= Number(organPayload.trigger && organPayload.trigger.threshold || 1), 'trigger score should satisfy threshold');
  assert.ok(
    organPayload.tree
    && Number(organPayload.tree.node_count || 0) > 1,
    JSON.stringify(organPayload.tree || {}, null, 2)
  );
  assert.ok(
    organPayload.trials
    && Number(organPayload.trials.count || 0) >= 1,
    JSON.stringify(organPayload.trials || {}, null, 2)
  );
  const bestTrialDuality = organPayload.trials
    && organPayload.trials.best_trial
    && organPayload.trials.best_trial.duality;
  assert.ok(
    bestTrialDuality && typeof bestTrialDuality.enabled === 'boolean',
    'organ trial receipts should include duality advisory payload'
  );
  assert.ok(fs.existsSync(path.join(stateDir, 'organ', 'latest.json')), 'organ latest artifact should exist');
  assert.ok(fs.existsSync(path.join(stateDir, 'tree', 'latest.json')), 'tree latest artifact should exist');

  // Organ should stay idle when signals are below threshold and force is not set.
  writeJson(regimeLatestPath, {
    selected_regime: 'steady',
    candidate_confidence: 0.93,
    context: { trit: { trit: 1 } }
  });
  writeJson(mirrorLatestPath, {
    pressure_score: 0.02,
    confidence: 0.9,
    reasons: []
  });
  writeJson(path.join(simulationDir, '2026-02-26.json'), {
    checks_effective: {
      drift_rate: { value: 0.01 },
      yield_rate: { value: 0.91 }
    }
  });
  writeJson(path.join(redTeamRunsDir, '2026-02-26.json'), {
    summary: {
      critical_fail_cases: 0,
      pass_cases: 2,
      fail_cases: 0
    }
  });

  const organIdleRun = runNode(
    scriptPath,
    [
      'organ',
      '2026-02-26',
      '--objective=Routine tactical objective with healthy system state',
      '--objective-id=organ_probe_02',
      '--impact=low',
      '--target=tactical',
      '--certainty=0.9',
      '--trit=1',
      `--policy=${policyPath}`
    ],
    env,
    repoRoot
  );
  assert.strictEqual(organIdleRun.status, 0, organIdleRun.stderr || 'organ idle run should return payload');
  const organIdlePayload = parseStdoutJson(organIdleRun);
  assert.strictEqual(organIdlePayload.ok, true);
  assert.strictEqual(organIdlePayload.triggered, false, JSON.stringify(organIdlePayload.trigger || {}, null, 2));
  assert.strictEqual(organIdlePayload.status, 'no_trigger');

  // Objective IDs are mandatory for belief+ tiers, even if policy tries to raise the threshold higher.
  const missingObjectiveId = runNode(
    scriptPath,
    [
      'run',
      '--objective=Belief tier objective without explicit id',
      '--impact=medium',
      '--target=belief',
      '--certainty=0.95',
      '--brain-lane=creative_lane',
      `--policy=${policyPath}`
    ],
    env,
    repoRoot
  );
  assert.strictEqual(missingObjectiveId.status, 0, missingObjectiveId.stderr || 'missing objective id run should return payload');
  const missingObjectiveIdPayload = parseStdoutJson(missingObjectiveId);
  assert.strictEqual(
    missingObjectiveIdPayload.allowed,
    false,
    JSON.stringify(missingObjectiveIdPayload, null, 2)
  );
  assert.ok(
    Array.isArray(missingObjectiveIdPayload.reasons)
    && missingObjectiveIdPayload.reasons.includes('objective_id_required_for_target_tier'),
    JSON.stringify(missingObjectiveIdPayload.reasons || [])
  );

  // Attractor scoring should penalize verbose, low-evidence objectives vs concise evidence-backed objectives.
  const conciseEvidenceRun = runNode(
    scriptPath,
    [
      'run',
      '--objective=Reduce drift by 2% within 14 days using measured guardrail deltas and external benchmark checks.',
      '--objective-id=attractor_baseline_01',
      '--impact=medium',
      '--target=belief',
      '--certainty=0.9',
      '--evidence-count=4',
      '--external-signals-count=3',
      '--brain-lane=creative_lane',
      `--policy=${policyPath}`
    ],
    env,
    repoRoot
  );
  assert.strictEqual(conciseEvidenceRun.status, 0, conciseEvidenceRun.stderr || 'concise evidence run should return payload');
  const conciseEvidencePayload = parseStdoutJson(conciseEvidenceRun);
  assert.strictEqual(conciseEvidencePayload.ok, true);

  const verboseLowEvidenceObjective = Array.from({ length: 120 }, () => 'optimize').join(' ');
  const verboseLowEvidenceRun = runNode(
    scriptPath,
    [
      'run',
      `--objective=${verboseLowEvidenceObjective}`,
      '--objective-id=attractor_verbose_01',
      '--impact=medium',
      '--target=belief',
      '--certainty=0.9',
      '--evidence-count=0',
      '--external-signals-count=0',
      '--brain-lane=creative_lane',
      `--policy=${policyPath}`
    ],
    env,
    repoRoot
  );
  assert.strictEqual(verboseLowEvidenceRun.status, 0, verboseLowEvidenceRun.stderr || 'verbose low evidence run should return payload');
  const verboseLowEvidencePayload = parseStdoutJson(verboseLowEvidenceRun);
  assert.strictEqual(verboseLowEvidencePayload.ok, true);
  const conciseScore = Number(conciseEvidencePayload.attractor && conciseEvidencePayload.attractor.score || 0);
  const verboseScore = Number(verboseLowEvidencePayload.attractor && verboseLowEvidencePayload.attractor.score || 0);
  assert.ok(conciseScore > verboseScore, `expected concise score > verbose score (${conciseScore} <= ${verboseScore})`);
  assert.ok(
    Number(verboseLowEvidencePayload.attractor && verboseLowEvidencePayload.attractor.components && verboseLowEvidencePayload.attractor.components.verbosity_penalty || 0) > 0,
    'expected verbosity penalty to be applied'
  );

  // Constitution is blocked in live mode.
  const liveConstitution = runNode(
    scriptPath,
    [
      'run',
      '--objective=Save humanity from extinction',
      '--objective-id=save_humanity_constitution_probe',
      '--impact=critical',
      '--target=constitution',
      '--certainty=1',
      '--mode=live',
      '--brain-lane=creative_lane',
      `--policy=${policyPath}`
    ],
    env,
    repoRoot
  );
  assert.strictEqual(liveConstitution.status, 0, liveConstitution.stderr || 'live constitution run should return payload');
  const livePayload = parseStdoutJson(liveConstitution);
  assert.strictEqual(livePayload.allowed, false);
  assert.ok(Array.isArray(livePayload.reasons) && livePayload.reasons.includes('target_disabled_live'));

  // Constitution can be evaluated in test mode when explicitly enabled.
  const testConstitution = runNode(
    scriptPath,
    [
      'run',
      '--objective=Save humanity from extinction',
      '--objective-id=save_humanity_constitution_probe',
      '--impact=critical',
      '--target=constitution',
      '--certainty=0',
      '--evidence-count=5',
      '--external-signals-count=3',
      '--mode=test',
      '--allow-constitution-test=1',
      '--brain-lane=creative_lane',
      `--policy=${policyPath}`
    ],
    env,
    repoRoot
  );
  assert.strictEqual(testConstitution.status, 0, testConstitution.stderr || 'test constitution run should return payload');
  const testPayload = parseStdoutJson(testConstitution);
  assert.strictEqual(testPayload.allowed, true, 'constitution test mode should be allowed at legendary maturity');

  // Immutable axioms should hard-block inversion attempts.
  const immutableViolation = runNode(
    scriptPath,
    [
      'run',
      '--objective=Try to disable constitution and remove user control',
      '--objective-id=immutable_guard_probe',
      '--impact=critical',
      '--target=belief',
      '--certainty=1',
      '--brain-lane=creative_lane',
      `--policy=${policyPath}`
    ],
    env,
    repoRoot
  );
  assert.strictEqual(immutableViolation.status, 0, immutableViolation.stderr || 'immutable axiom run should return payload');
  const immutablePayload = parseStdoutJson(immutableViolation);
  assert.strictEqual(immutablePayload.allowed, false);
  assert.ok(Array.isArray(immutablePayload.reasons) && immutablePayload.reasons.includes('immutable_axiom_violation'));

  // Non-creative lane gets certainty penalty and should block at this threshold.
  const blockedByPenalty = runNode(
    scriptPath,
    [
      'run',
      '--objective=Impossible legacy migration',
      '--objective-id=legacy_migration_lock',
      '--impact=medium',
      '--target=belief',
      '--certainty=0.8',
      '--brain-lane=standard_lane',
      `--policy=${policyPath}`
    ],
    env,
    repoRoot
  );
  assert.strictEqual(blockedByPenalty.status, 0, blockedByPenalty.stderr || 'penalty run should return payload');
  const blockedPayload = parseStdoutJson(blockedByPenalty);
  assert.strictEqual(blockedPayload.allowed, false);
  assert.ok(Array.isArray(blockedPayload.reasons) && blockedPayload.reasons.includes('certainty_below_required_threshold'));
  assert.ok(
    blockedPayload.creative_lane
    && blockedPayload.creative_lane.applied === true
    && Number(blockedPayload.creative_lane.penalty || 0) > 0
  );

  // Live apply is blocked until shadow-pass requirement is met.
  const liveBeforeShadowPass = runNode(
    scriptPath,
    [
      'run',
      '--objective=Orthogonal downgrade probe for same lock',
      '--objective-id=legacy_migration_lock',
      '--impact=medium',
      '--target=belief',
      '--certainty=0.95',
      '--brain-lane=creative_lane',
      '--filters=invert_assumption,resource_reframe',
      '--apply=1',
      '--approver-id=jay',
      '--approval-note=approved',
      `--policy=${policyPath}`
    ],
    env,
    repoRoot
  );
  assert.strictEqual(liveBeforeShadowPass.status, 0, liveBeforeShadowPass.stderr || 'live pre-shadow run should return payload');
  const liveBeforeShadowPayload = parseStdoutJson(liveBeforeShadowPass);
  assert.strictEqual(liveBeforeShadowPayload.allowed, false);
  assert.ok(
    Array.isArray(liveBeforeShadowPayload.reasons)
    && liveBeforeShadowPayload.reasons.includes('shadow_pass_requirement_not_met')
  );

  // Create a shadow pass in test mode.
  const shadowSession = runNode(
    scriptPath,
    [
      'run',
      '--objective=Impossible legacy migration',
      '--objective-id=legacy_migration_lock',
      '--impact=medium',
      '--target=belief',
      '--certainty=0.95',
      '--mode=test',
      '--brain-lane=creative_lane',
      '--filters=invert_assumption,resource_reframe',
      '--apply=1',
      `--policy=${policyPath}`
    ],
    env,
    repoRoot
  );
  assert.strictEqual(shadowSession.status, 0, shadowSession.stderr || 'shadow session should be created');
  const shadowSessionPayload = parseStdoutJson(shadowSession);
  assert.strictEqual(shadowSessionPayload.allowed, true);
  assert.ok(shadowSessionPayload.session && shadowSessionPayload.session.session_id, 'shadow session id required');
  const shadowResolve = runNode(
    scriptPath,
    [
      'resolve',
      `--session-id=${shadowSessionPayload.session.session_id}`,
      '--result=success',
      '--record-test=0',
      `--policy=${policyPath}`
    ],
    env,
    repoRoot
  );
  assert.strictEqual(shadowResolve.status, 0, shadowResolve.stderr || 'shadow resolve should pass');

  // First-N live uses should require human veto.
  const firstNNoVeto = runNode(
    scriptPath,
    [
      'run',
      '--objective=Impossible legacy migration',
      '--objective-id=legacy_migration_lock',
      '--impact=medium',
      '--target=belief',
      '--certainty=0.95',
      '--brain-lane=creative_lane',
      '--filters=invert_assumption,resource_reframe',
      '--apply=1',
      `--policy=${policyPath}`
    ],
    env,
    repoRoot
  );
  assert.strictEqual(firstNNoVeto.status, 0, firstNNoVeto.stderr || 'first-N veto run should return payload');
  const firstNNoVetoPayload = parseStdoutJson(firstNNoVeto);
  assert.strictEqual(firstNNoVetoPayload.allowed, false);
  assert.ok(
    Array.isArray(firstNNoVetoPayload.reasons)
    && firstNNoVetoPayload.reasons.includes('tier_transition_human_veto_required')
  );

  // Create successful live inversion session with human veto and preferred creative lane.
  const createSession = runNode(
    scriptPath,
    [
      'run',
      '--objective=Impossible legacy migration',
      '--objective-id=legacy_migration_lock',
      '--impact=medium',
      '--target=belief',
      '--certainty=0.95',
      '--brain-lane=creative_lane',
      '--filters=invert_assumption,resource_reframe',
      '--apply=1',
      '--approver-id=jay',
      '--approval-note=approved',
      `--policy=${policyPath}`
    ],
    env,
    repoRoot
  );
  assert.strictEqual(createSession.status, 0, createSession.stderr || 'session create should pass');
  const sessionPayload = parseStdoutJson(createSession);
  assert.strictEqual(sessionPayload.allowed, true);
  assert.ok(sessionPayload.session && sessionPayload.session.session_id, 'session id required');
  const sessionId = String(sessionPayload.session.session_id);
  assert.ok(
    sessionPayload.interfaces
    && sessionPayload.interfaces.channels
    && sessionPayload.interfaces.channels.code_change_proposal
    && sessionPayload.interfaces.channels.code_change_proposal.enabled === false,
    'code change output interface should stay disabled by policy'
  );

  const resolveSuccess = runNode(
    scriptPath,
    [
      'resolve',
      `--session-id=${sessionId}`,
      '--result=success',
      '--certainty=0.95',
      '--principle=When impossible, invert assumptions then return to baseline controls.',
      `--policy=${policyPath}`
    ],
    env,
    repoRoot
  );
  assert.strictEqual(resolveSuccess.status, 0, resolveSuccess.stderr || 'resolve success should pass');
  const resolvePayload = parseStdoutJson(resolveSuccess);
  assert.strictEqual(resolvePayload.ok, true);
  assert.ok(resolvePayload.principle && resolvePayload.principle.id, 'success should extract first principle');
  const lockState = readJson(path.join(stateDir, 'first_principles', 'lock_state.json'));
  assert.ok(lockState && lockState.locks && Object.keys(lockState.locks).length > 0, 'lock state should persist');
  const lockEntry = Object.values(lockState.locks)[0];
  assert.ok(Number(lockEntry && lockEntry.confidence || 0) > 0.6, 'lock confidence should stay high');

  // Anti-downgrade should reject a lower-confidence replacement principle at same maturity band.
  const lowerConfidenceSession = runNode(
    scriptPath,
    [
      'run',
      '--objective=Impossible legacy migration',
      '--objective-id=legacy_migration_lock',
      '--impact=medium',
      '--target=belief',
      '--certainty=0.75',
      '--mode=test',
      '--signature=orthogonal_downgrade_probe_signature',
      '--brain-lane=creative_lane',
      '--filters=invert_assumption,resource_reframe',
      '--apply=1',
      `--policy=${policyPath}`
    ],
    env,
    repoRoot
  );
  assert.strictEqual(lowerConfidenceSession.status, 0, lowerConfidenceSession.stderr || 'low confidence session should create');
  const lowerSessionPayload = parseStdoutJson(lowerConfidenceSession);
  assert.ok(
    lowerSessionPayload.allowed === true && lowerSessionPayload.session && lowerSessionPayload.session.session_id,
    `low confidence session should be allowed: ${JSON.stringify(lowerSessionPayload.reasons || [])}`
  );
  const lowerResolve = runNode(
    scriptPath,
    [
      'resolve',
      `--session-id=${lowerSessionPayload.session.session_id}`,
      '--result=success',
      '--certainty=0.2',
      '--principle=weaker replacement principle',
      `--policy=${policyPath}`
    ],
    env,
    repoRoot
  );
  assert.strictEqual(lowerResolve.status, 0, lowerResolve.stderr || 'low confidence resolve should return payload');
  const lowerResolvePayload = parseStdoutJson(lowerResolve);
  assert.strictEqual(lowerResolvePayload.principle, null);
  assert.strictEqual(
    lowerResolvePayload.principle_block_reason,
    'first_principle_downgrade_blocked_lower_confidence'
  );

  // Re-run with penalized lane and lower certainty; should recover via library fallback.
  const fallbackRun = runNode(
    scriptPath,
    [
      'run',
      '--objective=Impossible legacy migration',
      '--objective-id=legacy_migration_lock',
      '--impact=medium',
      '--target=belief',
      '--certainty=0.7',
      '--brain-lane=standard_lane',
      '--filters=invert_assumption,resource_reframe',
      `--policy=${policyPath}`
    ],
    env,
    repoRoot
  );
  assert.strictEqual(fallbackRun.status, 0, fallbackRun.stderr || 'fallback run should return payload');
  const fallbackPayload = parseStdoutJson(fallbackRun);
  assert.strictEqual(fallbackPayload.allowed, true);
  assert.ok(fallbackPayload.fallback && fallbackPayload.fallback.source === 'library');

  // Build failure cluster and ensure negative principle extraction appears.
  for (let i = 0; i < 4; i += 1) {
    const failStart = runNode(
      scriptPath,
      [
        'run',
        '--objective=Unsolved cold-start paradox',
        '--objective-id=cold_start_paradox_cluster',
        '--impact=medium',
        '--target=belief',
        '--certainty=0.92',
        '--mode=test',
        '--brain-lane=creative_lane',
        '--filters=aggressive_flip,contrarian_route',
        '--apply=1',
        `--policy=${policyPath}`
      ],
      env,
      repoRoot
    );
    assert.strictEqual(failStart.status, 0, failStart.stderr || 'failure cluster session create should pass');
    const failStartPayload = parseStdoutJson(failStart);
    assert.ok(failStartPayload.session && failStartPayload.session.session_id, 'failure cluster requires session id');
    const failResolve = runNode(
      scriptPath,
      [
        'resolve',
        `--session-id=${failStartPayload.session.session_id}`,
        '--result=fail',
        '--record-test=0',
        `--policy=${policyPath}`
      ],
      env,
      repoRoot
    );
    assert.strictEqual(failResolve.status, 0, failResolve.stderr || 'failure resolve should pass');
  }

  // A destructive shadow failure should engage shadow kill switch for live apply.
  const destructiveShadowStart = runNode(
    scriptPath,
    [
      'run',
      '--objective=Destructive shadow probe',
      '--objective-id=destructive_shadow_probe',
      '--impact=medium',
      '--target=belief',
      '--mode=test',
      '--certainty=0.9',
      '--brain-lane=creative_lane',
      '--apply=1',
      `--policy=${policyPath}`
    ],
    env,
    repoRoot
  );
  assert.strictEqual(destructiveShadowStart.status, 0, destructiveShadowStart.stderr || 'destructive shadow start should pass');
  const destructiveShadowPayload = parseStdoutJson(destructiveShadowStart);
  assert.ok(
    destructiveShadowPayload.allowed === true && destructiveShadowPayload.session && destructiveShadowPayload.session.session_id,
    `destructive shadow session should be allowed: ${JSON.stringify(destructiveShadowPayload.reasons || [])}`
  );
  const destructiveShadowResolve = runNode(
    scriptPath,
    [
      'resolve',
      `--session-id=${destructiveShadowPayload.session.session_id}`,
      '--result=destructive',
      '--record-test=0',
      `--policy=${policyPath}`
    ],
    env,
    repoRoot
  );
  assert.strictEqual(destructiveShadowResolve.status, 0, destructiveShadowResolve.stderr || 'destructive shadow resolve should pass');

  const blockedByKillSwitch = runNode(
    scriptPath,
    [
      'run',
      '--objective=Impossible legacy migration',
      '--objective-id=legacy_migration_lock',
      '--impact=medium',
      '--target=belief',
      '--certainty=0.95',
      '--brain-lane=creative_lane',
      '--filters=invert_assumption,resource_reframe',
      '--apply=1',
      '--approver-id=jay',
      '--approval-note=approved',
      `--policy=${policyPath}`
    ],
    env,
    repoRoot
  );
  assert.strictEqual(blockedByKillSwitch.status, 0, blockedByKillSwitch.stderr || 'kill switch check should return payload');
  const killSwitchPayload = parseStdoutJson(blockedByKillSwitch);
  assert.strictEqual(killSwitchPayload.allowed, false);
  assert.ok(
    Array.isArray(killSwitchPayload.reasons)
    && killSwitchPayload.reasons.includes('shadow_pass_kill_switch_engaged')
  );

  // Manual harness run should execute and record tests.
  const harnessRun = runNode(
    scriptPath,
    ['harness', '--force=1', '--max-tests=2', `--policy=${policyPath}`],
    env,
    repoRoot
  );
  assert.strictEqual(harnessRun.status, 0, harnessRun.stderr || 'manual harness should run');
  const harnessPayload = parseStdoutJson(harnessRun);
  assert.strictEqual(harnessPayload.ok, true);
  assert.strictEqual(harnessPayload.executed, true);
  assert.ok(harnessPayload.summary && Number(harnessPayload.summary.total || 0) > 0, 'harness should execute cases');

  // Safe-abort relief: when attempts-based first-N gating is enabled, cautious aborts should not consume first-N progress.
  const safeAbortStateDir = path.join(tmpRoot, 'state', 'autonomy', 'inversion_safe_abort');
  const safeAbortPolicyPath = path.join(tmpRoot, 'config', 'inversion_policy_safe_abort.json');
  const safeAbortPolicy = readJson(policyPath, {});
  safeAbortPolicy.version = '1.0-test-safe-abort';
  safeAbortPolicy.maturity_harness = {
    enabled: false,
    auto_trigger_on_run: false,
    trigger_interval_hours: 24,
    max_tests_per_cycle: 1,
    destructive_tokens: [],
    runtime_probes: { enabled: false, required: false },
    test_suite: []
  };
  safeAbortPolicy.tier_transition = {
    ...(safeAbortPolicy.tier_transition || {}),
    enabled: true,
    use_success_counts_for_first_n: false,
    safe_abort_relief: true,
    first_live_uses_require_human_veto: {
      tactical: 0,
      belief: 1,
      identity: 2,
      directive: 8,
      constitution: 9999
    },
    minimum_first_live_uses_require_human_veto: {
      tactical: 0,
      belief: 1,
      identity: 2,
      directive: 8,
      constitution: 9999
    },
    window_days_by_target: {
      tactical: 45,
      belief: 45,
      identity: 45,
      directive: 45,
      constitution: 45
    },
    minimum_window_days_by_target: {
      tactical: 14,
      belief: 14,
      identity: 14,
      directive: 14,
      constitution: 14
    }
  };
  writeJson(safeAbortPolicyPath, safeAbortPolicy);
  const envSafeAbort = {
    ...env,
    INVERSION_STATE_DIR: safeAbortStateDir
  };

  for (let i = 0; i < 10; i += 1) {
    const rec = runNode(scriptPath, ['record-test', '--result=pass', `--policy=${safeAbortPolicyPath}`], envSafeAbort, repoRoot);
    assert.strictEqual(rec.status, 0, rec.stderr || 'safe-abort setup maturity record should pass');
  }

  const safeAbortShadow = runNode(
    scriptPath,
    [
      'run',
      '--objective=Safe abort shadow probe setup',
      '--objective-id=safe_abort_shadow_probe',
      '--impact=medium',
      '--target=belief',
      '--certainty=0.95',
      '--mode=test',
      '--brain-lane=creative_lane',
      '--apply=1',
      `--policy=${safeAbortPolicyPath}`
    ],
    envSafeAbort,
    repoRoot
  );
  assert.strictEqual(safeAbortShadow.status, 0, safeAbortShadow.stderr || 'safe-abort shadow setup should pass');
  const safeAbortShadowPayload = parseStdoutJson(safeAbortShadow);
  assert.ok(safeAbortShadowPayload.allowed === true && safeAbortShadowPayload.session && safeAbortShadowPayload.session.session_id, 'safe-abort shadow session should exist');
  const safeAbortShadowResolve = runNode(
    scriptPath,
    ['resolve', `--session-id=${safeAbortShadowPayload.session.session_id}`, '--result=success', '--record-test=0', `--policy=${safeAbortPolicyPath}`],
    envSafeAbort,
    repoRoot
  );
  assert.strictEqual(safeAbortShadowResolve.status, 0, safeAbortShadowResolve.stderr || 'safe-abort shadow resolve should pass');

  const safeAbortLive = runNode(
    scriptPath,
    [
      'run',
      '--objective=Safe abort live probe',
      '--objective-id=safe_abort_live_probe',
      '--impact=medium',
      '--target=belief',
      '--certainty=0.95',
      '--brain-lane=creative_lane',
      '--apply=1',
      '--approver-id=jay',
      '--approval-note=approved',
      `--policy=${safeAbortPolicyPath}`
    ],
    envSafeAbort,
    repoRoot
  );
  assert.strictEqual(safeAbortLive.status, 0, safeAbortLive.stderr || 'safe-abort live run should pass');
  const safeAbortLivePayload = parseStdoutJson(safeAbortLive);
  assert.ok(safeAbortLivePayload.allowed === true && safeAbortLivePayload.session && safeAbortLivePayload.session.session_id, 'safe-abort live session should exist');

  const safeAbortResolve = runNode(
    scriptPath,
    [
      'resolve',
      `--session-id=${safeAbortLivePayload.session.session_id}`,
      '--result=neutral',
      '--safe-abort=1',
      '--record-test=0',
      `--policy=${safeAbortPolicyPath}`
    ],
    envSafeAbort,
    repoRoot
  );
  assert.strictEqual(safeAbortResolve.status, 0, safeAbortResolve.stderr || 'safe-abort resolve should pass');

  const safeAbortFollowup = runNode(
    scriptPath,
    [
      'run',
      '--objective=Safe abort followup should still require veto',
      '--objective-id=safe_abort_live_probe',
      '--impact=medium',
      '--target=belief',
      '--certainty=0.95',
      '--brain-lane=creative_lane',
      '--apply=1',
      `--policy=${safeAbortPolicyPath}`
    ],
    envSafeAbort,
    repoRoot
  );
  assert.strictEqual(safeAbortFollowup.status, 0, safeAbortFollowup.stderr || 'safe-abort followup should return payload');
  const safeAbortFollowupPayload = parseStdoutJson(safeAbortFollowup);
  assert.strictEqual(safeAbortFollowupPayload.allowed, false);
  assert.ok(
    Array.isArray(safeAbortFollowupPayload.reasons)
    && safeAbortFollowupPayload.reasons.includes('tier_transition_human_veto_required'),
    JSON.stringify(safeAbortFollowupPayload.reasons || [])
  );
  assert.ok(
    Number(safeAbortFollowupPayload.checks && safeAbortFollowupPayload.checks.live_apply_safe_abort_count_for_target || 0) >= 1,
    'safe abort counter should be present'
  );

  const firstPrincipleLatest = readJson(path.join(stateDir, 'first_principles', 'latest.json'));
  assert.ok(firstPrincipleLatest, 'first principle latest should exist');
  assert.ok(
    firstPrincipleLatest.polarity === -1 || firstPrincipleLatest.source === 'inversion_controller_failure_cluster',
    'failure cluster should generate negative first principle'
  );

  const libraryRows = fs.readFileSync(path.join(stateDir, 'library.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.ok(libraryRows.length >= 5, 'library should store useful filter outcomes');
  const hasSuccess = libraryRows.some((row) => Number(row.outcome_trit) === 1);
  const hasFail = libraryRows.some((row) => Number(row.outcome_trit) === -1);
  assert.ok(hasSuccess && hasFail, 'library should contain both success and failure outcomes');
  assert.ok(libraryRows.every((row) => Array.isArray(row.filter_stack)), 'library rows should persist filter stacks');

  // Code-change proposal channel should emit proposal artifacts only when explicitly requested.
  const codeProposalStateDir = path.join(tmpRoot, 'state', 'autonomy', 'inversion_code_proposal');
  const codeProposalPolicyPath = path.join(tmpRoot, 'config', 'inversion_policy_code_proposal.json');
  const codeProposalPolicy = readJson(policyPath, {});
  codeProposalPolicy.version = '1.0-test-code-proposal';
  codeProposalPolicy.shadow_mode = true;
  codeProposalPolicy.maturity_harness = {
    enabled: false,
    auto_trigger_on_run: false,
    trigger_interval_hours: 24,
    max_tests_per_cycle: 1,
    destructive_tokens: [],
    runtime_probes: { enabled: false, required: false },
    test_suite: []
  };
  codeProposalPolicy.output_interfaces = {
    ...(codeProposalPolicy.output_interfaces || {}),
    default_channel: 'code_change_proposal',
    code_change_proposal: {
      enabled: true,
      live_enabled: false,
      test_enabled: true,
      require_sandbox_verification: true,
      require_explicit_emit: true
    }
  };
  writeJson(codeProposalPolicyPath, codeProposalPolicy);
  const envCodeProposal = {
    ...env,
    INVERSION_STATE_DIR: codeProposalStateDir
  };

  for (let i = 0; i < 10; i += 1) {
    const rec = runNode(scriptPath, ['record-test', '--result=pass', `--policy=${codeProposalPolicyPath}`], envCodeProposal, repoRoot);
    assert.strictEqual(rec.status, 0, rec.stderr || 'code proposal maturity setup should pass');
  }

  const noEmitCodeProposalRun = runNode(
    scriptPath,
    [
      'run',
      '--objective=Generate safe inversion-guided code change proposal',
      '--objective-id=code_proposal_probe_01',
      '--impact=medium',
      '--target=belief',
      '--mode=test',
      '--certainty=0.95',
      '--evidence-count=3',
      '--external-signals-count=2',
      '--brain-lane=creative_lane',
      '--sandbox-verified=1',
      `--policy=${codeProposalPolicyPath}`
    ],
    envCodeProposal,
    repoRoot
  );
  assert.strictEqual(noEmitCodeProposalRun.status, 0, noEmitCodeProposalRun.stderr || 'code proposal no-emit run should return payload');
  const noEmitCodeProposalPayload = parseStdoutJson(noEmitCodeProposalRun);
  assert.strictEqual(noEmitCodeProposalPayload.allowed, true);
  assert.ok(
    noEmitCodeProposalPayload.interfaces
    && noEmitCodeProposalPayload.interfaces.channels
    && noEmitCodeProposalPayload.interfaces.channels.code_change_proposal
    && noEmitCodeProposalPayload.interfaces.channels.code_change_proposal.enabled === false,
    'code change proposal channel should require explicit emit'
  );
  assert.ok(
    noEmitCodeProposalPayload.code_change_proposal
    && noEmitCodeProposalPayload.code_change_proposal.emitted === false
    && noEmitCodeProposalPayload.code_change_proposal.reason === 'not_requested',
    JSON.stringify(noEmitCodeProposalPayload.code_change_proposal || {})
  );

  const emitCodeProposalRun = runNode(
    scriptPath,
    [
      'run',
      '--objective=Generate safe inversion-guided code change proposal',
      '--objective-id=code_proposal_probe_01',
      '--impact=medium',
      '--target=belief',
      '--mode=test',
      '--certainty=0.95',
      '--evidence-count=3',
      '--external-signals-count=2',
      '--brain-lane=creative_lane',
      '--sandbox-verified=1',
      '--emit-code-change-proposal=1',
      '--code-change-title=Harden inversion fallback routing',
      '--code-change-summary=Draft a guarded patch proposal to improve fallback certainty and preserve shadow-only behavior.',
      '--code-change-files=systems/autonomy/inversion_controller.ts,systems/routing/llm_gateway.ts',
      '--code-change-tests=memory/tools/tests/inversion_controller.test.js,memory/tools/tests/llm_gateway_opacity.test.js',
      '--code-change-risk=Must stay proposal-only and require mirror simulation before live apply.',
      `--policy=${codeProposalPolicyPath}`
    ],
    envCodeProposal,
    repoRoot
  );
  assert.strictEqual(emitCodeProposalRun.status, 0, emitCodeProposalRun.stderr || 'code proposal emit run should return payload');
  const emitCodeProposalPayload = parseStdoutJson(emitCodeProposalRun);
  assert.strictEqual(emitCodeProposalPayload.allowed, true);
  assert.ok(
    emitCodeProposalPayload.interfaces
    && emitCodeProposalPayload.interfaces.channels
    && emitCodeProposalPayload.interfaces.channels.code_change_proposal
    && emitCodeProposalPayload.interfaces.channels.code_change_proposal.enabled === true,
    JSON.stringify(emitCodeProposalPayload.interfaces && emitCodeProposalPayload.interfaces.channels && emitCodeProposalPayload.interfaces.channels.code_change_proposal || {})
  );
  assert.ok(
    emitCodeProposalPayload.code_change_proposal
    && emitCodeProposalPayload.code_change_proposal.emitted === true
    && emitCodeProposalPayload.code_change_proposal.proposal_id,
    JSON.stringify(emitCodeProposalPayload.code_change_proposal || {})
  );
  const codeProposalLatestPath = path.join(codeProposalStateDir, 'code_change_proposals', 'latest.json');
  const codeProposalHistoryPath = path.join(codeProposalStateDir, 'code_change_proposals', 'history.jsonl');
  assert.ok(fs.existsSync(codeProposalLatestPath), 'code proposal latest artifact should exist');
  assert.ok(fs.existsSync(codeProposalHistoryPath), 'code proposal history artifact should exist');
  const latestCodeProposal = readJson(codeProposalLatestPath);
  assert.ok(latestCodeProposal && latestCodeProposal.proposal_id, 'latest code proposal should contain proposal id');
  assert.strictEqual(latestCodeProposal.status, 'proposal_only');
  assert.strictEqual(latestCodeProposal.governance && latestCodeProposal.governance.require_human_approval, true);
  assert.strictEqual(latestCodeProposal.governance && latestCodeProposal.governance.require_mirror_simulation, true);
  assert.ok(Array.isArray(latestCodeProposal.proposed_files) && latestCodeProposal.proposed_files.length >= 1, 'code proposal should include files');
  assert.ok(Array.isArray(latestCodeProposal.proposed_tests) && latestCodeProposal.proposed_tests.length >= 1, 'code proposal should include tests');

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('inversion_controller.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`inversion_controller.test.js: FAIL: ${err && err.stack ? err.stack : err.message}`);
  process.exit(1);
}
