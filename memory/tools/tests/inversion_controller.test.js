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

  const env = {
    ...process.env,
    INVERSION_STATE_DIR: stateDir
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

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('inversion_controller.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`inversion_controller.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
