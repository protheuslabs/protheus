#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'primitives', 'long_horizon_planning_primitive.js');

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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lhp-primitive-'));
  const policyPath = path.join(tmp, 'long_horizon_planning_policy.json');
  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    shadow_only: true,
    token_budget: {
      min_thinking_tokens: 128,
      max_thinking_tokens: 2048,
      low_complexity_threshold: 0.3,
      high_complexity_threshold: 0.7
    },
    structured_thinking: {
      enabled: true,
      max_steps: 10,
      include_risk_checks: true
    },
    test_time_scaling: {
      enabled: true,
      self_critique_enabled: true,
      max_revision_loops: 4,
      confidence_floor: 0.7,
      confidence_ceiling: 0.98,
      deep_mode_threshold: 0.45,
      debate_mode_threshold: 0.78
    },
    state: {
      latest_path: path.join(tmp, 'state', 'primitives', 'long_horizon_planning', 'latest.json'),
      history_path: path.join(tmp, 'state', 'primitives', 'long_horizon_planning', 'history.jsonl'),
      receipts_path: path.join(tmp, 'state', 'primitives', 'long_horizon_planning', 'receipts.jsonl')
    }
  });

  const env = {
    LONG_HORIZON_PLANNING_POLICY_PATH: policyPath
  };

  const runOut = run([
    'run',
    '--objective-id=lhp_test',
    '--objective=Design a multi-step rollout with migration, rollback, and compliance checkpoints',
    '--risk=high'
  ], env);
  assert.strictEqual(runOut.status, 0, runOut.stderr || runOut.stdout);
  const payload = parseJson(runOut.stdout);
  assert.ok(payload && payload.ok === true, 'run payload should be ok');
  assert.strictEqual(payload.type, 'long_horizon_planning');
  assert.ok(Number(payload.thinking_token_budget || 0) >= 128, 'budget should meet configured minimum');
  assert.ok(Number(payload.thinking_token_budget || 0) <= 2048, 'budget should respect configured max');
  assert.ok(
    payload.structured_thinking
      && Array.isArray(payload.structured_thinking.steps)
      && payload.structured_thinking.steps.length >= 4,
    'structured steps should be emitted'
  );
  assert.ok(payload.test_time_scaling && payload.test_time_scaling.enabled === true, 'test-time scaling should be enabled');
  assert.ok(
    Array.isArray(payload.test_time_scaling.thinking_chain)
      && payload.test_time_scaling.thinking_chain.length >= 3,
    'thinking chain should include critique/revision structure'
  );
  assert.ok(
    Number(payload.test_time_scaling.final_confidence || 0) >= Number(payload.test_time_scaling.initial_confidence || 0),
    'final confidence should not regress after scaling loops'
  );
  assert.ok(
    ['fast_reflex', 'deep_thinking', 'multi_agent_debate'].includes(String(payload.recommended_reasoning_strategy || '')),
    'recommended reasoning strategy should be emitted'
  );

  const statusOut = run(['status'], env);
  assert.strictEqual(statusOut.status, 0, statusOut.stderr || statusOut.stdout);
  const statusPayload = parseJson(statusOut.stdout);
  assert.ok(statusPayload && statusPayload.ok === true, 'status payload should be ok');
  assert.strictEqual(statusPayload.objective_id, 'lhp_test');
  assert.ok(Number(statusPayload.structured_step_count || 0) >= 4);
  assert.ok(Number(statusPayload.final_confidence || 0) > 0, 'status should expose final confidence');
  assert.ok(
    ['fast_reflex', 'deep_thinking', 'multi_agent_debate'].includes(String(statusPayload.recommended_reasoning_strategy || '')),
    'status should include strategy recommendation'
  );

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('long_horizon_planning_primitive.test.js: OK');
} catch (err) {
  console.error(`long_horizon_planning_primitive.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
