#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function runNode(repoRoot, args, env) {
  return spawnSync('node', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...env
    }
  });
}

function parseStdoutJson(proc) {
  const text = String(proc.stdout || '').trim();
  if (!text) return null;
  const lines = text.split('\n').map((row) => row.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i]);
    } catch {
      // continue
    }
  }
  return null;
}

function basePolicy() {
  return {
    version: '1.0',
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
        novice: 3,
        developing: 3,
        mature: 3,
        seasoned: 4,
        legendary: 4
      }
    },
    impact: {
      max_target_rank: {
        low: 4,
        medium: 4,
        high: 4,
        critical: 4
      }
    },
    certainty_gate: {
      thresholds: {
        novice: { low: 0, medium: 0, high: 0, critical: 0 },
        developing: { low: 0, medium: 0, high: 0, critical: 0 },
        mature: { low: 0, medium: 0, high: 0, critical: 0 },
        seasoned: { low: 0, medium: 0, high: 0, critical: 0 },
        legendary: { low: 0, medium: 0, high: 0, critical: 0 }
      },
      allow_zero_for_legendary_critical: true
    },
    targets: {
      tactical: { rank: 1, live_enabled: true, test_enabled: true, require_human_veto_live: false, min_shadow_hours: 0 },
      belief: { rank: 2, live_enabled: true, test_enabled: true, require_human_veto_live: false, min_shadow_hours: 0 },
      identity: { rank: 3, live_enabled: true, test_enabled: true, require_human_veto_live: true, min_shadow_hours: 0 },
      directive: { rank: 4, live_enabled: false, test_enabled: true, require_human_veto_live: true, min_shadow_hours: 0 },
      constitution: { rank: 4, live_enabled: false, test_enabled: true, require_human_veto_live: true, min_shadow_hours: 0 }
    },
    tier_transition: {
      enabled: false,
      human_veto_min_target_rank: 2,
      use_success_counts_for_first_n: true,
      safe_abort_relief: true,
      first_live_uses_require_human_veto: { tactical: 0, belief: 0, identity: 0, directive: 0, constitution: 0 },
      minimum_first_live_uses_require_human_veto: { tactical: 0, belief: 0, identity: 0, directive: 0, constitution: 0 },
      window_days_by_target: { tactical: 30, belief: 30, identity: 30, directive: 30, constitution: 30 },
      minimum_window_days_by_target: { tactical: 1, belief: 1, identity: 1, directive: 1, constitution: 1 }
    },
    shadow_pass_gate: {
      enabled: false,
      require_for_live_apply: false,
      required_passes_by_target: { tactical: 0, belief: 0, identity: 0, directive: 0, constitution: 0 },
      max_critical_failures_by_target: { tactical: 9999, belief: 9999, identity: 9999, directive: 9999, constitution: 9999 },
      window_days_by_target: { tactical: 30, belief: 30, identity: 30, directive: 30, constitution: 30 }
    },
    live_graduation_ladder: {
      enabled: true,
      canary_quotas_by_target: { tactical: 0, belief: 2, identity: 2, directive: 2, constitution: 9999 },
      observer_quorum_by_target: { tactical: 0, belief: 1, identity: 1, directive: 1, constitution: 2 },
      observer_approval_window_days_by_target: { tactical: 30, belief: 30, identity: 30, directive: 30, constitution: 30 },
      regression_rollback_enabled: true,
      max_regressions_by_target: { tactical: 3, belief: 0, identity: 0, directive: 0, constitution: 0 },
      regression_window_days_by_target: { tactical: 30, belief: 30, identity: 30, directive: 30, constitution: 30 }
    },
    immutable_axioms: {
      enabled: true,
      semantic: {
        enabled: true,
        min_role_hits: 2,
        ontology: {
          actions: {
            disable: ['disable', 'turn off', 'shut down'],
            remove: ['remove', 'strip']
          },
          subjects: {
            user: ['user', 'human', 'owner']
          },
          objects: {
            sovereignty: ['sovereignty', 'veto', 'control']
          }
        }
      },
      axioms: [
        {
          id: 'preserve_user_sovereignty',
          patterns: ['placeholder_only_phrase_that_will_not_match'],
          regex: [],
          intent_tags: [],
          semantic_requirements: {
            actions: ['disable', 'remove'],
            subjects: ['user'],
            objects: ['sovereignty']
          }
        }
      ]
    },
    creative_preference: {
      enabled: false,
      preferred_creative_lane_ids: [],
      non_creative_certainty_penalty: 0
    },
    guardrails: {
      default_session_ttl_minutes: 60,
      max_active_sessions: 8,
      objective_id_required_min_target_rank: 2,
      max_similar_failures_by_band: {
        novice: 10,
        developing: 10,
        mature: 10,
        seasoned: 10,
        legendary: 10
      }
    },
    library: {
      max_entries: 1000,
      min_similarity_for_reuse: 0.1,
      token_weight: 0.5,
      trit_weight: 0.25,
      target_weight: 0.25,
      failed_repetition_similarity_block: 0.95
    },
    first_principles: {
      enabled: false,
      allow_failure_cluster_extraction: false,
      failure_cluster_min: 5,
      anti_downgrade: {
        enabled: false,
        require_same_or_higher_maturity: false,
        prevent_lower_confidence_same_band: false,
        same_band_confidence_floor_ratio: 0.9
      }
    },
    maturity_harness: {
      enabled: false,
      auto_every_hours: 24,
      max_tests_per_run: 3,
      suite: []
    },
    attractor: {
      enabled: false,
      min_alignment_by_target: { tactical: 0, belief: 0, identity: 0, directive: 0, constitution: 0 },
      weights: {
        objective_specificity: 0,
        evidence_backing: 0,
        certainty: 0,
        trit_alignment: 0,
        impact_alignment: 0,
        verbosity_penalty: 0
      }
    },
    organ: {
      enabled: false
    },
    output_interfaces: {
      default_channel: 'strategy_hint',
      belief_update: { enabled: true, live_enabled: true, test_enabled: true },
      strategy_hint: { enabled: true, live_enabled: true, test_enabled: true },
      workflow_hint: { enabled: true, live_enabled: true, test_enabled: true },
      code_change_proposal: { enabled: false, live_enabled: false, test_enabled: false }
    },
    telemetry: {
      emit_events: true,
      max_reasons: 20
    }
  };
}

function writeTierState(stateDir, version, successCount, regressionCount) {
  const nowMs = Date.now();
  const list = (count) => Array.from({ length: count }, (_, idx) => new Date(nowMs + (idx * 1000)).toISOString());
  writeJson(path.join(stateDir, 'tier_governance.json'), {
    schema_id: 'inversion_tier_governance_state',
    schema_version: '1.0',
    active_policy_version: version,
    updated_at: new Date(nowMs).toISOString(),
    scopes: {
      [version]: {
        live_apply_attempts: { tactical: [], belief: list(successCount), identity: [], directive: [], constitution: [] },
        live_apply_successes: { tactical: [], belief: list(successCount), identity: [], directive: [], constitution: [] },
        live_apply_safe_aborts: { tactical: [], belief: [], identity: [], directive: [], constitution: [] },
        shadow_passes: { tactical: [], belief: [], identity: [], directive: [], constitution: [] },
        shadow_critical_failures: { tactical: [], belief: list(regressionCount), identity: [], directive: [], constitution: [] }
      }
    }
  });
}

function run() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const scriptPath = path.join(repoRoot, 'systems', 'autonomy', 'inversion_controller.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'inversion-live-ladder-semantic-'));
  const policyPath = path.join(tmp, 'config', 'inversion_policy.json');
  const stateDir = path.join(tmp, 'state', 'autonomy', 'inversion');
  ensureDir(stateDir);

  const policy = basePolicy();
  writeJson(policyPath, policy);

  // Semantic matcher should block even when pattern/regex do not match.
  const semanticBlocked = runNode(repoRoot, [
    scriptPath,
    'run',
    '--objective=Shut down human veto control in this workflow',
    '--objective-id=obj_semantic_01',
    '--impact=medium',
    '--target=belief',
    '--certainty=0.9',
    '--trit=1',
    '--mode=live',
    '--apply=0',
    `--policy=${policyPath}`
  ], {
    INVERSION_STATE_DIR: stateDir
  });
  assert.strictEqual(semanticBlocked.status, 0, semanticBlocked.stderr || 'semantic run should return payload');
  const semanticPayload = parseStdoutJson(semanticBlocked);
  assert.ok(semanticPayload && Array.isArray(semanticPayload.reasons), 'semantic payload should include reasons');
  assert.ok(semanticPayload.reasons.includes('immutable_axiom_violation'), 'semantic matcher should trigger immutable axiom violation');

  // Ladder should block without observer quorum/canary quota.
  writeTierState(stateDir, policy.version, 0, 0);
  const blocked = runNode(repoRoot, [
    scriptPath,
    'run',
    '--objective=Try a safe belief inversion',
    '--objective-id=obj_ladder_01',
    '--impact=medium',
    '--target=belief',
    '--certainty=0.9',
    '--trit=1',
    '--mode=live',
    '--apply=1',
    '--approver-id=owner_a',
    '--approval-note=initial belief lane approval',
    `--policy=${policyPath}`
  ], {
    INVERSION_STATE_DIR: stateDir
  });
  assert.strictEqual(blocked.status, 0, blocked.stderr || 'ladder blocked run should return payload');
  const blockedPayload = parseStdoutJson(blocked);
  assert.ok(blockedPayload.reasons.includes('live_graduation_canary_quota_not_met'));
  assert.ok(blockedPayload.reasons.includes('live_graduation_observer_quorum_not_met'));

  // Observer approval + canary quota should allow apply.
  const approval = runNode(repoRoot, [
    scriptPath,
    'observer-approve',
    '--target=belief',
    '--observer-id=observer_1',
    '--note=reviewed canary telemetry',
    `--policy=${policyPath}`
  ], {
    INVERSION_STATE_DIR: stateDir
  });
  assert.strictEqual(approval.status, 0, approval.stderr || 'observer approve should pass');

  writeTierState(stateDir, policy.version, 2, 0);
  const pass = runNode(repoRoot, [
    scriptPath,
    'run',
    '--objective=Try a safe belief inversion with full evidence',
    '--objective-id=obj_ladder_02',
    '--impact=medium',
    '--target=belief',
    '--certainty=0.9',
    '--trit=1',
    '--mode=live',
    '--apply=1',
    '--approver-id=owner_a',
    '--approval-note=approved after canary and observer quorum',
    `--policy=${policyPath}`
  ], {
    INVERSION_STATE_DIR: stateDir
  });
  assert.strictEqual(pass.status, 0, pass.stderr || 'ladder pass run should return payload');
  const passPayload = parseStdoutJson(pass);
  assert.strictEqual(passPayload.allowed, true, `expected allowed=true, got reasons: ${JSON.stringify(passPayload.reasons || [])}`);

  // Regression rollback should force block even when canary/quorum pass.
  writeTierState(stateDir, policy.version, 2, 1);
  const rollback = runNode(repoRoot, [
    scriptPath,
    'run',
    '--objective=Attempt belief inversion after regression event',
    '--objective-id=obj_ladder_03',
    '--impact=medium',
    '--target=belief',
    '--certainty=0.9',
    '--trit=1',
    '--mode=live',
    '--apply=1',
    '--approver-id=owner_a',
    '--approval-note=approval present but rollback should win',
    `--policy=${policyPath}`
  ], {
    INVERSION_STATE_DIR: stateDir
  });
  assert.strictEqual(rollback.status, 0, rollback.stderr || 'rollback run should return payload');
  const rollbackPayload = parseStdoutJson(rollback);
  assert.ok(rollbackPayload.reasons.includes('live_graduation_regression_rollback_engaged'));

  console.log('inversion_live_ladder_semantic.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`inversion_live_ladder_semantic.test.js: FAIL: ${err && err.stack ? err.stack : err.message}`);
  process.exit(1);
}
