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

function runNode(cwd, args) {
  return spawnSync('node', args, { cwd, encoding: 'utf8', env: process.env });
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

function run() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const scriptPath = path.join(repoRoot, 'systems', 'security', 'goal_preservation_kernel.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-preservation-'));
  const constitution = path.join(tmp, 'constitution.md');
  fs.writeFileSync(constitution, '# Constitution\nPreserve user sovereignty\n', 'utf8');
  const symbiosisPolicyPath = path.join(tmp, 'symbiosis_policy.json');

  const identityLatestPath = path.join(tmp, 'state', 'autonomy', 'identity_anchor', 'latest.json');
  const preNeuralStatePath = path.join(tmp, 'state', 'symbiosis', 'pre_neuralink_interface', 'state.json');
  const deepSymStatePath = path.join(tmp, 'state', 'symbiosis', 'deep_understanding', 'state.json');
  const observerLatestPath = path.join(tmp, 'state', 'autonomy', 'observer_mirror', 'latest.json');
  writeJson(identityLatestPath, {
    checked: 10,
    blocked: 8,
    identity_drift_score: 0.58,
    max_identity_drift_score: 0.58
  });
  writeJson(preNeuralStatePath, {
    consent_state: 'paused',
    signals_total: 8,
    routed_total: 1,
    blocked_total: 6
  });
  writeJson(deepSymStatePath, {
    samples: 5,
    style: {
      directness: 0.5,
      brevity: 0.45,
      proactive_delta: 0.4
    }
  });
  writeJson(observerLatestPath, {
    observer: { mood: 'strained' },
    summary: { rates: { ship_rate: 0.2, hold_rate: 0.8 } }
  });

  writeJson(symbiosisPolicyPath, {
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
      state_path: path.join(tmp, 'state', 'symbiosis', 'coherence', 'state.json'),
      latest_path: path.join(tmp, 'state', 'symbiosis', 'coherence', 'latest.json'),
      receipts_path: path.join(tmp, 'state', 'symbiosis', 'coherence', 'receipts.jsonl'),
      identity_latest_path: identityLatestPath,
      pre_neuralink_state_path: preNeuralStatePath,
      deep_symbiosis_state_path: deepSymStatePath,
      observer_mirror_latest_path: observerLatestPath
    }
  });

  const policyPath = path.join(tmp, 'goal_policy.json');
  writeJson(policyPath, {
    version: '1.0',
    strict_mode: true,
    constitution_path: constitution,
    protected_axiom_markers: ['user sovereignty'],
    blocked_mutation_paths: ['^systems/security/guard\\.(ts|js)$'],
    symbiosis_recursion_gate: {
      enabled: true,
      shadow_only: false,
      signal_policy_path: symbiosisPolicyPath
    },
    output: {
      state_path: path.join(tmp, 'state', 'latest.json'),
      receipts_path: path.join(tmp, 'state', 'receipts.jsonl')
    }
  });

  const blockedProposalPath = path.join(tmp, 'blocked_proposal.json');
  writeJson(blockedProposalPath, {
    proposal_id: 'p_blocked',
    mutation_paths: ['systems/security/guard.ts'],
    summary: 'disable user sovereignty checks'
  });

  const blocked = runNode(repoRoot, [scriptPath, 'evaluate', `--proposal-file=${blockedProposalPath}`, `--policy=${policyPath}`]);
  assert.strictEqual(blocked.status, 0, blocked.stderr || 'blocked proposal should return payload');
  const blockedPayload = parseJson(blocked.stdout);
  assert.strictEqual(blockedPayload.allowed, false, 'blocked proposal must be denied');
  assert.ok(Array.isArray(blockedPayload.reasons) && blockedPayload.reasons.includes('blocked_mutation_path'));

  const safeProposalPath = path.join(tmp, 'safe_proposal.json');
  writeJson(safeProposalPath, {
    proposal_id: 'p_safe',
    mutation_paths: ['systems/weaver/weaver_core.ts'],
    summary: 'improve value arbitration logging only'
  });

  const allowed = runNode(repoRoot, [scriptPath, 'evaluate', `--proposal-file=${safeProposalPath}`, `--policy=${policyPath}`]);
  assert.strictEqual(allowed.status, 0, allowed.stderr || 'safe proposal should return payload');
  const allowedPayload = parseJson(allowed.stdout);
  assert.strictEqual(allowedPayload.allowed, true, `safe proposal should be allowed: ${JSON.stringify(allowedPayload.reasons || [])}`);

  const recursionProposalPath = path.join(tmp, 'recursion_proposal.json');
  writeJson(recursionProposalPath, {
    proposal_id: 'p_recursion',
    target_system: 'self_improvement',
    mutation_paths: ['systems/autonomy/self_code_evolution_sandbox.ts'],
    summary: 'raise recursive self-improvement depth',
    recursion_depth: 9
  });
  const recursionBlocked = runNode(repoRoot, [scriptPath, 'evaluate', `--proposal-file=${recursionProposalPath}`, `--policy=${policyPath}`]);
  assert.strictEqual(recursionBlocked.status, 0, recursionBlocked.stderr || 'recursion proposal should return payload');
  const recursionPayload = parseJson(recursionBlocked.stdout);
  assert.strictEqual(recursionPayload.allowed, false, 'recursion proposal must be denied under low symbiosis');
  assert.ok(Array.isArray(recursionPayload.reasons) && recursionPayload.reasons.includes('symbiosis_recursion_gate_blocked'));

  console.log('goal_preservation_kernel.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`goal_preservation_kernel.test.js: FAIL: ${err && err.stack ? err.stack : err.message}`);
  process.exit(1);
}
