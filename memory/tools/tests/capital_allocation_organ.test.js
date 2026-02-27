#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'budget', 'capital_allocation_organ.js');

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function run(args, env) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8'
  });
}

function parseJson(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'capital-allocation-organ-'));
  const policyPath = path.join(tmp, 'capital_allocation_policy.json');
  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    strict_default: false,
    min_simulation_score: 0.6,
    min_risk_adjusted_return: 0,
    buckets: {
      compute: { max_share: 0.6, drawdown_stop_pct: 0.5 },
      tools: { max_share: 0.3, drawdown_stop_pct: 0.5 }
    },
    state_path: path.join(tmp, 'state', 'budget', 'capital_allocation', 'state.json'),
    latest_path: path.join(tmp, 'state', 'budget', 'capital_allocation', 'latest.json'),
    receipts_path: path.join(tmp, 'state', 'budget', 'capital_allocation', 'receipts.jsonl')
  });
  const env = { CAPITAL_ALLOCATION_POLICY_PATH: policyPath };

  const seed = run(['seed', '--balance=1000'], env);
  assert.strictEqual(seed.status, 0, seed.stderr || 'seed should pass');

  const sim = run(['simulate', '--bucket=compute', '--amount=100', '--expected-return=1.2', '--risk-score=0.2'], env);
  assert.strictEqual(sim.status, 0, sim.stderr || 'simulate should pass');
  const simPayload = parseJson(sim.stdout);
  assert.ok(simPayload && simPayload.ok === true, 'simulation payload should be ok');
  const simulationId = simPayload.simulation && simPayload.simulation.simulation_id;
  assert.ok(simulationId, 'simulation id required');

  const alloc = run(['allocate', '--bucket=compute', '--amount=100', `--simulation-id=${simulationId}`, '--strict=1'], env);
  assert.strictEqual(alloc.status, 0, alloc.stderr || 'allocate should pass');
  const allocPayload = parseJson(alloc.stdout);
  assert.ok(allocPayload && allocPayload.ok === true, 'allocation payload should be ok');
  const allocationId = allocPayload.allocation && allocPayload.allocation.allocation_id;
  assert.ok(allocationId, 'allocation id required');

  const settle = run(['settle', `--allocation-id=${allocationId}`, '--actual-return=0.1'], env);
  assert.strictEqual(settle.status, 0, settle.stderr || 'settle should pass');
  const settlePayload = parseJson(settle.stdout);
  assert.ok(settlePayload && settlePayload.ok === true, 'settle payload should be ok');

  const evaluate = run(['evaluate', '--days=30', '--strict=1'], env);
  assert.strictEqual(evaluate.status, 0, evaluate.stderr || 'evaluate should pass strict');
  const evalPayload = parseJson(evaluate.stdout);
  assert.ok(evalPayload && evalPayload.ok === true, 'evaluate payload should be ok');
  assert.ok(evalPayload.metrics.risk_adjusted_return >= 0, 'risk-adjusted return should be non-negative');

  const status = run(['status', '--days=30'], env);
  assert.strictEqual(status.status, 0, status.stderr || 'status should pass');
  const statusPayload = parseJson(status.stdout);
  assert.ok(statusPayload && statusPayload.ok === true, 'status payload should be ok');
  assert.ok(Number(statusPayload.open_allocations || 0) === 0, 'settled allocation should not remain open');

  console.log('capital_allocation_organ.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`capital_allocation_organ.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
