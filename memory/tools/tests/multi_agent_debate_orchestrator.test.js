#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'autonomy', 'multi_agent_debate_orchestrator.js');

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function run(args, env = {}) {
  const proc = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env }
  });
  return {
    status: typeof proc.status === 'number' ? proc.status : 1,
    stdout: String(proc.stdout || ''),
    stderr: String(proc.stderr || '')
  };
}

function parseJson(stdout) {
  const lines = String(stdout || '').trim().split('\n').map((row) => row.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i]);
    } catch {
      // continue
    }
  }
  return null;
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mac-orchestrator-'));
  const policyPath = path.join(tmp, 'multi_agent_debate_policy.json');
  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    shadow_only: true,
    rounds: {
      max_rounds: 2,
      min_agents: 3,
      consensus_threshold: 0.7
    },
    debate_resolution: {
      confidence_floor: 0.35,
      disagreement_gap_threshold: 0.12,
      runoff_enabled: true,
      max_runoff_rounds: 1,
      runoff_consensus_threshold: 0.57,
      require_distinct_roles_for_quorum: true
    },
    agent_roles: {
      soldier_guard: { weight: 1.1, bias: 'safety' },
      creative_probe: { weight: 1.0, bias: 'growth' },
      orderly_executor: { weight: 1.2, bias: 'delivery' }
    },
    outputs: {
      latest_path: path.join(tmp, 'state', 'autonomy', 'multi_agent_debate', 'latest.json'),
      history_path: path.join(tmp, 'state', 'autonomy', 'multi_agent_debate', 'history.jsonl'),
      receipts_path: path.join(tmp, 'state', 'autonomy', 'multi_agent_debate', 'receipts.jsonl')
    }
  });

  const env = {
    MULTI_AGENT_DEBATE_POLICY_PATH: policyPath
  };

  const input = {
    objective_id: 'mac_test',
    objective: 'Choose the best value axis for this run',
    candidates: [
      { candidate_id: 'quality', score: 0.72, confidence: 0.72, risk: 'low' },
      { candidate_id: 'revenue', score: 0.75, confidence: 0.74, risk: 'high' },
      { candidate_id: 'learning', score: 0.74, confidence: 0.73, risk: 'medium' }
    ]
  };

  const runOut = run([
    'run',
    `--input-json=${JSON.stringify(input)}`
  ], env);
  assert.strictEqual(runOut.status, 0, runOut.stderr || runOut.stdout);
  const payload = parseJson(runOut.stdout);
  assert.ok(payload && payload.ok === true, 'run payload should be ok');
  assert.strictEqual(payload.type, 'multi_agent_debate_orchestrator');
  assert.ok(Array.isArray(payload.ranked_candidates) && payload.ranked_candidates.length >= 1, 'ranked candidates should exist');
  assert.ok(Array.isArray(payload.debate_transcript) && payload.debate_transcript.length >= 3, 'transcript should include round votes');
  assert.ok(typeof payload.consensus === 'boolean', 'consensus flag should be present');
  assert.ok(typeof payload.confidence_score === 'number', 'confidence score should be present');
  assert.ok(typeof payload.disagreement_index === 'number', 'disagreement index should be present');
  assert.ok(payload.quorum_rule && payload.quorum_rule.require_distinct_roles_for_quorum === true, 'quorum rule details should be present');
  assert.ok(payload.debate_resolution && payload.debate_resolution.runoff_executed === true, 'runoff should execute on disagreement');
  assert.ok(payload.debate_resolution.runoff_consensus === true, 'runoff should reach consensus for top candidates');
  assert.ok(payload.recommended_candidate_id, 'recommended candidate should be emitted');

  const statusOut = run(['status'], env);
  assert.strictEqual(statusOut.status, 0, statusOut.stderr || statusOut.stdout);
  const statusPayload = parseJson(statusOut.stdout);
  assert.ok(statusPayload && statusPayload.ok === true, 'status payload should be ok');
  assert.strictEqual(statusPayload.objective_id, 'mac_test');
  assert.ok(typeof statusPayload.confidence_score === 'number', 'status should expose confidence score');
  assert.ok(typeof statusPayload.disagreement_index === 'number', 'status should expose disagreement index');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('multi_agent_debate_orchestrator.test.js: OK');
} catch (err) {
  console.error(`multi_agent_debate_orchestrator.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
