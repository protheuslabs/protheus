#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const OPS = path.join(ROOT, 'client', 'runtime', 'systems', 'ops', 'run_protheus_ops.js');

function parseLastJson(stdout) {
  const lines = String(stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line.startsWith('{')) continue;
    try {
      return JSON.parse(line);
    } catch {}
  }
  return null;
}

function runOps(args, env = {}) {
  const run = spawnSync(process.execPath, [OPS].concat(args), {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  const payload = parseLastJson(run.stdout);
  return {
    status: Number.isFinite(Number(run.status)) ? Number(run.status) : 1,
    stdout: String(run.stdout || ''),
    stderr: String(run.stderr || ''),
    payload,
  };
}

function assertOk(result, label) {
  assert.strictEqual(
    result.status,
    0,
    `${label} exited non-zero\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
  );
  assert(result.payload, `${label} did not emit JSON payload`);
  assert.strictEqual(result.payload.ok, true, `${label} payload not ok`);
}

function run() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-smoothness-'));
  const state = path.join(tmpDir, 'swarm-runtime-state.json');

  const concurrency = runOps([
    'swarm-runtime',
    'test',
    'concurrency',
    '--agents=10',
    '--metrics=detailed',
    `--state-path=${state}`,
  ]);
  assertOk(concurrency, 'test-concurrency');
  assert.strictEqual(concurrency.payload.test, 'concurrency');

  const recursive = runOps([
    'swarm-runtime',
    'test',
    'recursive',
    '--levels=5',
    `--state-path=${state}`,
  ]);
  assertOk(recursive, 'test-recursive');
  assert.strictEqual(recursive.payload.test, 'recursive');
  assert.strictEqual(recursive.payload.levels_completed, 5);

  const byzEnable = runOps([
    'swarm-runtime',
    'byzantine-test',
    'enable',
    `--state-path=${state}`,
  ]);
  assertOk(byzEnable, 'byzantine-enable');

  const byzantine = runOps([
    'swarm-runtime',
    'test',
    'byzantine',
    '--agents=5',
    '--corrupt=2',
    `--state-path=${state}`,
  ]);
  assertOk(byzantine, 'test-byzantine');
  assert.strictEqual(byzantine.payload.truth_constraints_disabled_for_testing, true);

  const budget = runOps([
    'swarm-runtime',
    'test',
    'budget',
    '--budget=120',
    '--warning-at=0.5',
    '--on-budget-exhausted=fail',
    '--expect-fail=1',
    '--task=summarize largest programming language communities',
    `--state-path=${state}`,
  ]);
  assertOk(budget, 'test-budget');
  assert.strictEqual(budget.payload.expectation_met, true);

  const persistent = runOps([
    'swarm-runtime',
    'test',
    'persistent',
    '--lifespan-sec=300',
    '--check-in-interval-sec=60',
    '--advance-ms=300000',
    `--state-path=${state}`,
  ]);
  assertOk(persistent, 'test-persistent');
  assert(Array.isArray(persistent.payload.ticked.finalized_sessions));
  assert(persistent.payload.ticked.finalized_sessions.length >= 1);

  const communication = runOps([
    'swarm-runtime',
    'test',
    'communication',
    '--delivery=at_least_once',
    '--simulate-first-attempt-fail=1',
    `--state-path=${state}`,
  ]);
  assertOk(communication, 'test-communication');
  assert.strictEqual(communication.payload.chain_complete, true);
  assert.strictEqual(Array.isArray(communication.payload.messages), true);
  assert.strictEqual(communication.payload.messages.length, 3);

  const heterogeneous = runOps([
    'swarm-runtime',
    'test',
    'heterogeneous',
    '--min-count=2',
    '--timeout-sec=10',
    `--state-path=${state}`,
  ]);
  assertOk(heterogeneous, 'test-heterogeneous');
  assert.strictEqual(heterogeneous.payload.coordination_success, true);
  assert(heterogeneous.payload.result_count >= 2);

  const status = runOps([
    'swarm-runtime',
    'status',
    `--state-path=${state}`,
  ]);
  assertOk(status, 'status');
  assert(
    Number(status.payload.session_count || 0) >= 10,
    `unexpected session_count in status: ${status.stdout}`
  );
}

run();
console.log(
  JSON.stringify({
    ok: true,
    type: 'swarm_runtime_smoothness_test',
  })
);
