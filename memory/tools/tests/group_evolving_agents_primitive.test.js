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

function runNode(scriptPath, args, env, cwd) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd,
    env,
    encoding: 'utf8'
  });
}

function parseJson(proc) {
  const raw = String(proc.stdout || '').trim();
  assert.ok(raw, 'expected JSON stdout');
  return JSON.parse(raw);
}

function run() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const scriptPath = path.join(repoRoot, 'systems', 'assimilation', 'group_evolving_agents_primitive.js');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'group-evo-'));

  const policyPath = path.join(tmpRoot, 'config', 'group_evolving_agents_primitive_policy.json');
  const stateDir = path.join(tmpRoot, 'state', 'assimilation', 'group_evolving_agents');

  writeJson(policyPath, {
    schema_id: 'group_evolving_agents_primitive_policy',
    schema_version: '1.0-test',
    enabled: true,
    shadow_only: true,
    sharing: {
      max_peer_experiences: 20,
      min_reuse_confidence: 0.5,
      innovation_bonus: 0.2
    },
    trust: {
      min_peer_trust: 0.3,
      trust_decay: 0.95,
      trust_gain: 0.05,
      trust_penalty: 0.1
    },
    state: {
      pool_path: path.join(stateDir, 'pool.json'),
      latest_path: path.join(stateDir, 'latest.json'),
      receipts_path: path.join(stateDir, 'receipts.jsonl')
    }
  });

  const env = {
    ...process.env,
    GROUP_EVOLVING_AGENTS_POLICY_PATH: policyPath
  };

  const input = {
    capability_id: 'cap.alpha',
    agent_id: 'agent.main',
    experiences: [
      {
        peer_id: 'peer.one',
        innovation_id: 'innovation.retry_window',
        confidence: 0.9,
        adopted: true,
        outcome: 'success'
      },
      {
        peer_id: 'peer.two',
        innovation_id: 'innovation.passport_chain',
        confidence: 0.8,
        adopted: false,
        outcome: 'shadow_only'
      },
      {
        peer_id: 'peer.three',
        innovation_id: 'innovation.low_confidence',
        confidence: 0.2,
        adopted: false,
        outcome: 'reject'
      }
    ]
  };

  const run1 = runNode(scriptPath, ['run', `--input-json=${JSON.stringify(input)}`], env, repoRoot);
  assert.strictEqual(run1.status, 0, run1.stderr || run1.stdout);
  const out1 = parseJson(run1);
  assert.strictEqual(out1.ok, true);
  assert.strictEqual(out1.capability_id, 'cap.alpha');
  assert.ok(Number(out1.accepted_experience_count || 0) >= 2, 'expected accepted peer experiences');
  assert.ok(Number(out1.group_advantage_score || 0) > 0, 'expected positive group advantage score');

  const run2 = runNode(scriptPath, ['run', `--input-json=${JSON.stringify(input)}`], env, repoRoot);
  assert.strictEqual(run2.status, 0, run2.stderr || run2.stdout);
  const out2 = parseJson(run2);
  assert.strictEqual(out2.ok, true);
  assert.ok(Number(out2.innovation_reuse_count || 0) >= 1, 'expected innovation reuse count');

  const status = runNode(scriptPath, ['status', '--capability-id=cap.alpha'], env, repoRoot);
  assert.strictEqual(status.status, 0, status.stderr || status.stdout);
  const statusOut = parseJson(status);
  assert.strictEqual(statusOut.ok, true);
  assert.ok(statusOut.capability_state, 'status should include capability state');

  console.log('group_evolving_agents_primitive.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`group_evolving_agents_primitive.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
