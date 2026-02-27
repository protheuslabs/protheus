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

function parseJson(proc, label) {
  const raw = String(proc.stdout || '').trim();
  assert.ok(raw, `${label}: expected stdout`);
  return JSON.parse(raw.split('\n').filter(Boolean).slice(-1)[0]);
}

function run() {
  const root = path.resolve(__dirname, '..', '..', '..');
  const scriptPath = path.join(root, 'systems', 'research', 'research_organ.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'research-organ-'));
  const policyPath = path.join(tmp, 'config', 'research_organ_policy.json');
  const runsDir = path.join(tmp, 'state', 'autonomy', 'research_organ', 'runs');
  const receiptsPath = path.join(tmp, 'state', 'autonomy', 'research_organ', 'receipts.jsonl');
  const latestPath = path.join(tmp, 'state', 'autonomy', 'research_organ', 'latest.json');

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    proposal_only: true,
    budget: {
      max_depth: 5,
      max_steps: 30,
      max_external_calls: 5
    },
    synthesis: {
      min_confidence_for_proposal: 0.4,
      max_proposals: 5
    },
    uncertainty_scaling: {
      enabled: true,
      min_depth: 2,
      uncertainty_weight: 0.7,
      value_weight: 0.3
    }
  });

  const env = {
    ...process.env,
    RESEARCH_ORGAN_POLICY_PATH: policyPath,
    RESEARCH_ORGAN_RUN_DIR: runsDir,
    RESEARCH_ORGAN_RECEIPTS_PATH: receiptsPath,
    RESEARCH_ORGAN_LATEST_PATH: latestPath
  };

  const runResult = runNode(scriptPath, [
    'run',
    '--objective=investigate queue deadlock',
    '--uncertainty=0.82',
    '--value-priority=0.64',
    '--capability-id=queue_deadlock_lane',
    '--metadata-json={"docs_urls":["https://docs.example/a"],"api_endpoints":["/v1/health"],"auth_model":"token","rate_limits":["60/min"]}'
  ], env, root);
  assert.strictEqual(runResult.status, 0, runResult.stderr || runResult.stdout);
  const runOut = parseJson(runResult, 'run');
  assert.strictEqual(runOut.ok, true);
  assert.strictEqual(runOut.organ, 'research');
  assert.ok(Number(runOut.scores.depth || 0) >= 2, 'depth should be scaled above min');
  assert.ok(Array.isArray(runOut.loops) && runOut.loops.length >= 2, 'loop should include multiple hops');
  assert.ok(Array.isArray(runOut.proposals), 'proposals should be present');
  assert.strictEqual(runOut.proposal_only, true);

  const statusLatest = runNode(scriptPath, ['status', 'latest'], env, root);
  assert.strictEqual(statusLatest.status, 0, statusLatest.stderr || statusLatest.stdout);
  const statusOut = parseJson(statusLatest, 'status');
  assert.strictEqual(statusOut.ok, true);
  assert.strictEqual(statusOut.payload.run_id, runOut.run_id);

  assert.ok(fs.existsSync(receiptsPath), 'research receipts should be written');
  const receiptLines = fs.readFileSync(receiptsPath, 'utf8').split('\n').filter(Boolean);
  assert.ok(receiptLines.length >= 1, 'at least one research receipt expected');
}

run();
