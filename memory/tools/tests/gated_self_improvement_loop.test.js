#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'autonomy', 'gated_self_improvement_loop.js');

function run(args, env) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    env,
    encoding: 'utf8'
  });
}

function parse(proc) {
  const raw = String(proc.stdout || '').trim();
  assert.ok(raw, `expected stdout JSON, stderr=${proc.stderr || ''}`);
  return JSON.parse(raw);
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gated-self-improvement-'));
  const policyPath = path.join(tmp, 'policy.json');
  const statePath = path.join(tmp, 'state.json');
  const receiptsPath = path.join(tmp, 'receipts.jsonl');
  const latestPath = path.join(tmp, 'latest.json');

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    shadow_only: false,
    require_objective_id: true,
    auto_rollback_on_regression: true,
    simulation_days: 90,
    rollout_stages: ['shadow', 'canary', 'live'],
    gates: {
      max_effective_drift_rate: 0.04,
      min_effective_yield_rate: 0.6,
      max_effective_safety_stop_rate: 0.01,
      max_red_critical_fail_cases: 0,
      max_red_fail_rate: 0.25
    },
    paths: {
      state_path: statePath,
      receipts_path: receiptsPath,
      latest_path: latestPath
    }
  });

  const env = {
    ...process.env,
    GATED_SELF_IMPROVEMENT_POLICY_PATH: policyPath
  };

  let r = run(['propose', '--target-path=systems/autonomy/example.ts'], env);
  assert.strictEqual(r.status, 1, 'objective_id should be required');

  r = run([
    'propose',
    '--objective-id=self_improvement_objective',
    '--target-path=systems/autonomy/example.ts',
    '--summary=improve guarded rollout',
    '--risk=medium'
  ], env);
  assert.strictEqual(r.status, 0, r.stderr || r.stdout || 'propose should pass');
  let out = parse(r);
  assert.strictEqual(out.ok, true);
  const proposalId = String(out.proposal && out.proposal.proposal_id || '');
  assert.ok(proposalId, 'proposal_id missing');

  const goodSim = {
    checks_effective: {
      drift_rate: { value: 0.01 },
      yield_rate: { value: 0.82 },
      safety_stop_rate: { value: 0.0 }
    }
  };
  const goodRed = {
    summary: {
      executed_cases: 8,
      fail_cases: 1,
      critical_fail_cases: 0
    }
  };

  r = run([
    'run',
    `--proposal-id=${proposalId}`,
    '--apply=1',
    '--mock-sandbox=1',
    '--approval-a=tester_a',
    '--approval-b=tester_b',
    `--simulation-json=${JSON.stringify(goodSim)}`,
    `--redteam-json=${JSON.stringify(goodRed)}`
  ], env);
  assert.strictEqual(r.status, 0, r.stderr || r.stdout || 'run shadow->canary should pass');
  out = parse(r);
  assert.strictEqual(String(out.stage || ''), 'canary');
  assert.strictEqual(out.gates && out.gates.pass, true);

  r = run([
    'run',
    `--proposal-id=${proposalId}`,
    '--apply=1',
    '--mock-sandbox=1',
    '--approval-a=tester_a',
    '--approval-b=tester_b',
    `--simulation-json=${JSON.stringify(goodSim)}`,
    `--redteam-json=${JSON.stringify(goodRed)}`
  ], env);
  assert.strictEqual(r.status, 0, r.stderr || r.stdout || 'run canary->live should pass');
  out = parse(r);
  assert.strictEqual(String(out.stage || ''), 'live');
  assert.strictEqual(out.sandbox && out.sandbox.merged, true, 'live stage should allow sandbox merge');

  const badSim = {
    checks_effective: {
      drift_rate: { value: 0.5 },
      yield_rate: { value: 0.1 },
      safety_stop_rate: { value: 0.2 }
    }
  };
  const badRed = {
    summary: {
      executed_cases: 4,
      fail_cases: 4,
      critical_fail_cases: 2
    }
  };
  r = run([
    'run',
    `--proposal-id=${proposalId}`,
    '--apply=1',
    '--mock-sandbox=1',
    `--simulation-json=${JSON.stringify(badSim)}`,
    `--redteam-json=${JSON.stringify(badRed)}`
  ], env);
  assert.strictEqual(r.status, 0, r.stderr || r.stdout || 'regression run should still execute and emit rollback');
  out = parse(r);
  assert.strictEqual(out.gates && out.gates.pass, false);
  assert.strictEqual(String(out.status || ''), 'rolled_back');
  assert.ok(out.rollback && out.rollback.ok === true, 'automatic rollback should trigger');

  r = run(['status', `--proposal-id=${proposalId}`], env);
  assert.strictEqual(r.status, 0, r.stderr || r.stdout || 'status should pass');
  out = parse(r);
  assert.ok(out.proposal && out.proposal.status === 'rolled_back', 'status should show rolled_back');

  console.log('gated_self_improvement_loop.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`gated_self_improvement_loop.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

