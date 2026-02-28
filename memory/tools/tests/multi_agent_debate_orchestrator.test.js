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
      consensus_threshold: 0.55
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
      { candidate_id: 'quality', score: 0.92, confidence: 0.8, risk: 'low' },
      { candidate_id: 'revenue', score: 0.7, confidence: 0.7, risk: 'high' },
      { candidate_id: 'learning', score: 0.75, confidence: 0.75, risk: 'medium' }
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

  const statusOut = run(['status'], env);
  assert.strictEqual(statusOut.status, 0, statusOut.stderr || statusOut.stdout);
  const statusPayload = parseJson(statusOut.stdout);
  assert.ok(statusPayload && statusPayload.ok === true, 'status payload should be ok');
  assert.strictEqual(statusPayload.objective_id, 'mac_test');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('multi_agent_debate_orchestrator.test.js: OK');
} catch (err) {
  console.error(`multi_agent_debate_orchestrator.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

