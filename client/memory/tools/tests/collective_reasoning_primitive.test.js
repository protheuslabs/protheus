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
  const scriptPath = path.join(repoRoot, 'systems', 'assimilation', 'collective_reasoning_primitive.js');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'collective-reason-'));

  const policyPath = path.join(tmpRoot, 'config', 'collective_reasoning_primitive_policy.json');
  const stateDir = path.join(tmpRoot, 'state', 'assimilation', 'collective_reasoning');

  writeJson(policyPath, {
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
      positive_delta: 0.05,
      negative_delta: 0.05
    },
    delegation: {
      max_assignees: 3,
      preferred_lanes: ['autonomous_micro_agent', 'storm_human_lane', 'mirror_lane']
    },
    state: {
      latest_path: path.join(stateDir, 'latest.json'),
      history_path: path.join(stateDir, 'history.jsonl'),
      trust_ledger_path: path.join(stateDir, 'trust_ledger.json'),
      receipts_path: path.join(stateDir, 'receipts.jsonl')
    }
  });

  const env = {
    ...process.env,
    COLLECTIVE_REASONING_POLICY_PATH: policyPath
  };

  const input = {
    capability_id: 'cap.alpha',
    lanes: [
      {
        agent_id: 'legal_gate',
        lane: 'mirror_lane',
        recommendation: 'assimilate_shadow',
        confidence: 0.9,
        evidence_strength: 0.8
      },
      {
        agent_id: 'research_probe',
        lane: 'autonomous_micro_agent',
        recommendation: 'assimilate_shadow',
        confidence: 0.8,
        evidence_strength: 0.8
      },
      {
        agent_id: 'profile_compiler',
        lane: 'storm_human_lane',
        recommendation: 'improve_existing',
        confidence: 0.4,
        evidence_strength: 0.5
      }
    ]
  };

  const runProc = runNode(scriptPath, ['run', `--input-json=${JSON.stringify(input)}`], env, repoRoot);
  assert.strictEqual(runProc.status, 0, runProc.stderr || runProc.stdout);
  const out = parseJson(runProc);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.quorum_met, true);
  assert.ok(Array.isArray(out.ranked_recommendations));
  assert.ok(Array.isArray(out.delegation_profile));
  assert.strictEqual(out.final_recommendation, 'assimilate_shadow');

  const outcomeInput = {
    ...input,
    observed_outcome: 'assimilate_shadow'
  };
  const runProc2 = runNode(scriptPath, ['run', `--input-json=${JSON.stringify(outcomeInput)}`], env, repoRoot);
  assert.strictEqual(runProc2.status, 0, runProc2.stderr || runProc2.stdout);

  const trustLedgerPath = path.join(stateDir, 'trust_ledger.json');
  const trustLedger = JSON.parse(fs.readFileSync(trustLedgerPath, 'utf8'));
  assert.ok(trustLedger.agents.legal_gate.trust_score >= 0.6, 'matching recommendation should not reduce trust');

  const statusProc = runNode(scriptPath, ['status'], env, repoRoot);
  assert.strictEqual(statusProc.status, 0, statusProc.stderr || statusProc.stdout);
  const status = parseJson(statusProc);
  assert.strictEqual(status.ok, true);
  assert.ok(Number(status.tracked_agents || 0) >= 3);

  console.log('collective_reasoning_primitive.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`collective_reasoning_primitive.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
