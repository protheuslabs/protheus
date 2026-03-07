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

function runNode(cwd, args, env = {}) {
  return spawnSync('node', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...env
    }
  });
}

function run() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const envelopeScript = path.join(repoRoot, 'systems', 'security', 'capability_envelope_guard.js');
  const eyeScript = path.join(repoRoot, 'systems', 'eye', 'eye_kernel.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'capability-envelope-'));

  const envelopePolicy = path.join(tmp, 'capability_envelope_policy.json');
  writeJson(envelopePolicy, {
    version: '1.0',
    strict_mode: true,
    lane_envelopes: {
      organ: { max_estimated_tokens: 10000, max_daily_actions: 100, blocked_risks: [], blocked_actions: [] },
      vassal: { max_estimated_tokens: 10000, max_daily_actions: 100, blocked_risks: [], blocked_actions: [] },
      external: { max_estimated_tokens: 50, max_daily_actions: 100, blocked_risks: ['critical'], blocked_actions: ['danger_action'] }
    }
  });
  const envelopeState = path.join(tmp, 'state', 'capability_envelope_state.json');
  const envelopeAudit = path.join(tmp, 'state', 'capability_envelope_audit.jsonl');

  const blocked = runNode(repoRoot, [
    envelopeScript,
    'evaluate',
    '--lane=external',
    '--action=danger_action',
    '--risk=critical',
    '--estimated-tokens=60',
    '--apply=0',
    `--policy=${envelopePolicy}`
  ], {
    CAPABILITY_ENVELOPE_STATE_PATH: envelopeState,
    CAPABILITY_ENVELOPE_AUDIT_PATH: envelopeAudit
  });
  assert.strictEqual(blocked.status, 0, blocked.stderr || 'envelope evaluate should return payload');
  const blockedPayload = parseJson(blocked.stdout);
  assert.strictEqual(blockedPayload.allowed, false, 'external danger action should be blocked');
  assert.ok(blockedPayload.reasons.includes('lane_action_blocked'));
  assert.ok(blockedPayload.reasons.includes('lane_risk_blocked'));
  assert.ok(blockedPayload.reasons.includes('lane_token_ceiling_exceeded'));

  const eyePolicy = path.join(tmp, 'eye_policy.json');
  writeJson(eyePolicy, {
    version: '1.0',
    default_decision: 'allow',
    clearance_levels: ['L0', 'L1', 'L2', 'L3'],
    risk: {
      escalate: [],
      deny: []
    },
    budgets: {
      global_daily_tokens: 100000
    },
    helix_gate: {
      enabled: false
    },
    lanes: {
      organ: { enabled: true, min_clearance: 'L1', daily_tokens: 100000, actions: ['execute'], targets: ['workflow'] },
      vassal: { enabled: true, min_clearance: 'L1', daily_tokens: 100000, actions: ['execute'], targets: ['local'] },
      external: { enabled: true, min_clearance: 'L1', daily_tokens: 100000, actions: ['execute', 'danger_action'], targets: ['web'] }
    }
  });
  const eyeState = path.join(tmp, 'eye_state.json');
  const eyeAudit = path.join(tmp, 'eye_audit.jsonl');
  const eyeLatest = path.join(tmp, 'eye_latest.json');

  const eyeBlocked = runNode(repoRoot, [
    eyeScript,
    'route',
    '--lane=external',
    '--target=web',
    '--action=danger_action',
    '--risk=critical',
    '--clearance=L3',
    '--estimated-tokens=60',
    '--apply=0',
    `--policy=${eyePolicy}`,
    `--state=${eyeState}`,
    `--audit=${eyeAudit}`,
    `--latest=${eyeLatest}`
  ], {
    CAPABILITY_ENVELOPE_POLICY_PATH: envelopePolicy,
    CAPABILITY_ENVELOPE_STATE_PATH: envelopeState,
    CAPABILITY_ENVELOPE_AUDIT_PATH: envelopeAudit
  });
  assert.strictEqual(eyeBlocked.status, 1, 'eye route should deny when capability envelope blocks');
  const eyeBlockedPayload = parseJson(eyeBlocked.stdout);
  assert.strictEqual(eyeBlockedPayload.decision, 'deny');
  assert.ok((eyeBlockedPayload.reasons || []).some((reason) => String(reason).startsWith('capability_envelope_')));

  console.log('capability_envelope_guard.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`capability_envelope_guard.test.js: FAIL: ${err && err.stack ? err.stack : err.message}`);
  process.exit(1);
}
