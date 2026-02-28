#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function parseJson(out) {
  const lines = String(out || '').trim().split('\n').map((row) => row.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i]);
    } catch {
      // continue
    }
  }
  return null;
}

function runNode(cwd, args) {
  return spawnSync('node', args, {
    cwd,
    encoding: 'utf8',
    env: process.env
  });
}

function run() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const scriptPath = path.join(repoRoot, 'systems', 'security', 'constitution_guardian.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'constitution-guardian-'));

  const constitutionPath = path.join(tmp, 'AGENT-CONSTITUTION.md');
  fs.writeFileSync(constitutionPath, '# Constitution\nOriginal\n', 'utf8');
  const candidatePath = path.join(tmp, 'candidate.md');
  fs.writeFileSync(candidatePath, '# Constitution\nUpdated\n', 'utf8');
  const recursionCandidatePath = path.join(tmp, 'candidate_recursion.md');
  fs.writeFileSync(recursionCandidatePath, '# Constitution\nUpdated with unbounded recursion language\n', 'utf8');

  const identityLatestPath = path.join(tmp, 'sym', 'identity', 'latest.json');
  const preNeuralStatePath = path.join(tmp, 'sym', 'pre_neuralink', 'state.json');
  const deepSymStatePath = path.join(tmp, 'sym', 'deep', 'state.json');
  const observerLatestPath = path.join(tmp, 'sym', 'observer', 'latest.json');
  const symPolicyPath = path.join(tmp, 'symbiosis_policy.json');

  writeJson(identityLatestPath, {
    checked: 12,
    blocked: 0,
    identity_drift_score: 0.04,
    max_identity_drift_score: 0.58
  });
  writeJson(preNeuralStatePath, {
    consent_state: 'granted',
    signals_total: 10,
    routed_total: 9,
    blocked_total: 1
  });
  writeJson(deepSymStatePath, {
    samples: 80,
    style: {
      directness: 0.95,
      brevity: 0.9,
      proactive_delta: 0.9
    }
  });
  writeJson(observerLatestPath, {
    observer: { mood: 'stable' },
    summary: { rates: { ship_rate: 0.9, hold_rate: 0.05 } }
  });

  writeJson(symPolicyPath, {
    version: '1.0-test',
    enabled: true,
    shadow_only: false,
    stale_after_minutes: 120,
    thresholds: {
      low_max: 0.45,
      medium_max: 0.75,
      high_min: 0.75,
      unbounded_min: 0.9,
      sustained_high_samples: 4
    },
    recursion: {
      low_depth: 1,
      medium_depth: 2,
      high_base_depth: 4,
      high_streak_gain_interval: 2,
      require_granted_consent_for_unbounded: true,
      require_identity_clear_for_unbounded: true
    },
    paths: {
      state_path: path.join(tmp, 'sym', 'coherence', 'state.json'),
      latest_path: path.join(tmp, 'sym', 'coherence', 'latest.json'),
      receipts_path: path.join(tmp, 'sym', 'coherence', 'receipts.jsonl'),
      identity_latest_path: identityLatestPath,
      pre_neuralink_state_path: preNeuralStatePath,
      deep_symbiosis_state_path: deepSymStatePath,
      observer_mirror_latest_path: observerLatestPath
    }
  });

  const policyPath = path.join(tmp, 'constitution_guardian_policy.json');
  writeJson(policyPath, {
    version: '1.0',
    constitution_path: constitutionPath,
    state_dir: path.join(tmp, 'state'),
    veto_window_days: 1,
    min_approval_note_chars: 4,
    require_dual_approval: true,
    enforce_inheritance_lock: true,
    emergency_rollback_requires_approval: true,
    symbiosis_recursion_invariant: {
      enabled: true,
      shadow_only: false,
      signal_policy_path: symPolicyPath
    }
  });

  const init = runNode(repoRoot, [scriptPath, 'init-genesis', `--policy=${policyPath}`]);
  assert.strictEqual(init.status, 0, init.stderr || 'init-genesis should pass');

  const propose = runNode(repoRoot, [
    scriptPath,
    'propose-change',
    `--candidate-file=${candidatePath}`,
    '--proposer-id=owner_a',
    '--reason=update constitution wording',
    `--policy=${policyPath}`
  ]);
  assert.strictEqual(propose.status, 0, propose.stderr || 'propose-change should pass');
  const proposePayload = parseJson(propose.stdout);
  const proposalId = proposePayload.proposal_id;

  const approve1 = runNode(repoRoot, [
    scriptPath,
    'approve-change',
    `--proposal-id=${proposalId}`,
    '--approver-id=owner_a',
    '--approval-note=first approval note',
    `--policy=${policyPath}`
  ]);
  assert.strictEqual(approve1.status, 0, approve1.stderr || 'first approval should pass');

  const approve2 = runNode(repoRoot, [
    scriptPath,
    'approve-change',
    `--proposal-id=${proposalId}`,
    '--approver-id=owner_b',
    '--approval-note=second approval note',
    `--policy=${policyPath}`
  ]);
  assert.strictEqual(approve2.status, 0, approve2.stderr || 'second approval should pass');

  const gauntlet = runNode(repoRoot, [
    scriptPath,
    'run-gauntlet',
    `--proposal-id=${proposalId}`,
    '--critical-failures=0',
    '--evidence=nursery-red-team-clean',
    `--policy=${policyPath}`
  ]);
  assert.strictEqual(gauntlet.status, 0, gauntlet.stderr || 'gauntlet should pass');

  const proposalFile = path.join(tmp, 'state', 'proposals', proposalId, 'proposal.json');
  const proposal = readJson(proposalFile);
  proposal.activate_after = new Date(Date.now() - 60 * 1000).toISOString();
  writeJson(proposalFile, proposal);

  const activate = runNode(repoRoot, [
    scriptPath,
    'activate-change',
    `--proposal-id=${proposalId}`,
    '--approver-id=owner_b',
    '--approval-note=activate after veto window',
    `--policy=${policyPath}`
  ]);
  assert.strictEqual(activate.status, 0, activate.stderr || 'activate should pass');

  const blockedOverride = runNode(repoRoot, [
    scriptPath,
    'enforce-inheritance',
    '--actor=workflow_engine',
    '--target=workflow',
    '--override=1',
    '--note=attempted override',
    `--policy=${policyPath}`
  ]);
  assert.strictEqual(blockedOverride.status, 1, 'override should be blocked by inheritance lock');

  const rollback = runNode(repoRoot, [
    scriptPath,
    'emergency-rollback',
    '--approver-id=owner_a',
    '--approval-note=rollback to known good',
    `--policy=${policyPath}`
  ]);
  assert.strictEqual(rollback.status, 0, rollback.stderr || 'emergency rollback should pass');

  const finalConstitution = fs.readFileSync(constitutionPath, 'utf8');
  assert.ok(finalConstitution.includes('Original'), 'rollback should restore original constitution snapshot');

  const proposeRecursion = runNode(repoRoot, [
    scriptPath,
    'propose-change',
    `--candidate-file=${recursionCandidatePath}`,
    '--proposer-id=owner_a',
    '--reason=allow unbounded recursion updates',
    `--policy=${policyPath}`
  ]);
  assert.strictEqual(proposeRecursion.status, 0, proposeRecursion.stderr || 'recursion propose should pass');
  const proposeRecursionPayload = parseJson(proposeRecursion.stdout);
  const recursionProposalId = proposeRecursionPayload.proposal_id;

  const approveRec1 = runNode(repoRoot, [
    scriptPath,
    'approve-change',
    `--proposal-id=${recursionProposalId}`,
    '--approver-id=owner_a',
    '--approval-note=first approval note',
    `--policy=${policyPath}`
  ]);
  assert.strictEqual(approveRec1.status, 0, approveRec1.stderr || 'recursion first approval should pass');

  const approveRec2 = runNode(repoRoot, [
    scriptPath,
    'approve-change',
    `--proposal-id=${recursionProposalId}`,
    '--approver-id=owner_b',
    '--approval-note=second approval note',
    `--policy=${policyPath}`
  ]);
  assert.strictEqual(approveRec2.status, 0, approveRec2.stderr || 'recursion second approval should pass');

  const gauntletRec = runNode(repoRoot, [
    scriptPath,
    'run-gauntlet',
    `--proposal-id=${recursionProposalId}`,
    '--critical-failures=0',
    '--evidence=nursery-red-team-clean',
    `--policy=${policyPath}`
  ]);
  assert.strictEqual(gauntletRec.status, 0, gauntletRec.stderr || 'recursion gauntlet should pass');

  const recursionProposalFile = path.join(tmp, 'state', 'proposals', recursionProposalId, 'proposal.json');
  const recursionProposal = readJson(recursionProposalFile);
  recursionProposal.activate_after = new Date(Date.now() - 60 * 1000).toISOString();
  writeJson(recursionProposalFile, recursionProposal);

  writeJson(identityLatestPath, {
    checked: 12,
    blocked: 11,
    identity_drift_score: 0.58,
    max_identity_drift_score: 0.58
  });
  writeJson(preNeuralStatePath, {
    consent_state: 'paused',
    signals_total: 10,
    routed_total: 1,
    blocked_total: 8
  });
  writeJson(observerLatestPath, {
    observer: { mood: 'strained' },
    summary: { rates: { ship_rate: 0.2, hold_rate: 0.8 } }
  });

  const recursionActivate = runNode(repoRoot, [
    scriptPath,
    'activate-change',
    `--proposal-id=${recursionProposalId}`,
    '--approver-id=owner_b',
    '--approval-note=activate recursive update',
    `--policy=${policyPath}`
  ]);
  assert.strictEqual(recursionActivate.status, 1, 'recursion activation should block under low symbiosis');
  const recursionActivatePayload = parseJson(recursionActivate.stdout);
  assert.strictEqual(String(recursionActivatePayload.error || ''), 'symbiosis_recursion_gate_blocked');

  console.log('constitution_guardian.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`constitution_guardian.test.js: FAIL: ${err && err.stack ? err.stack : err.message}`);
  process.exit(1);
}
