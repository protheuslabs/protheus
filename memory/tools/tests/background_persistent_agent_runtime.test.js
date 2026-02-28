#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'autonomy', 'background_persistent_agent_runtime.js');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function run(args, env = {}) {
  const proc = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8'
  });
  return {
    status: typeof proc.status === 'number' ? proc.status : 1,
    stdout: String(proc.stdout || ''),
    stderr: String(proc.stderr || '')
  };
}

function parseJson(stdout) {
  const lines = String(stdout || '').trim().split('\n').map((line) => line.trim()).filter(Boolean);
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'background-runtime-'));
  const policyPath = path.join(tmp, 'config', 'background_persistent_agent_runtime_policy.json');
  const stateDir = path.join(tmp, 'state', 'autonomy', 'background_persistent_runtime');
  writeJson(policyPath, {
    schema_id: 'background_persistent_agent_runtime_policy',
    schema_version: '1.0-test',
    enabled: true,
    shadow_only: true,
    consume_queue_on_tick: true,
    limits: {
      min_tick_interval_sec: 600,
      max_signals_per_tick: 16,
      max_activations_per_tick: 8
    },
    trigger_thresholds: {
      queue_backlog_min: 3,
      error_rate_min: 0.2,
      stale_age_min_sec: 900
    },
    trigger_task_map: {
      queue_backlog: ['anticipation', 'value_weaving'],
      error_pressure: ['security_vigilance'],
      stale_runtime: ['dream_consolidation']
    },
    state: {
      state_path: path.join(stateDir, 'state.json'),
      queue_path: path.join(stateDir, 'queue.jsonl'),
      latest_path: path.join(stateDir, 'latest.json'),
      receipts_path: path.join(stateDir, 'receipts.jsonl')
    }
  });

  const env = {
    BACKGROUND_PERSISTENT_RUNTIME_POLICY_PATH: policyPath
  };

  const enqueue = run([
    'enqueue',
    '--signal-json={"source":"unit_test","queue_backlog":5,"error_rate":0.05,"stale_age_sec":100}'
  ], env);
  assert.strictEqual(enqueue.status, 0, enqueue.stderr || enqueue.stdout);
  const enqueuePayload = parseJson(enqueue.stdout);
  assert.ok(enqueuePayload && enqueuePayload.ok === true, 'enqueue should pass');

  const tick = run(['tick', '--source=unit_test', '--apply=1'], env);
  assert.strictEqual(tick.status, 0, tick.stderr || tick.stdout);
  const tickPayload = parseJson(tick.stdout);
  assert.ok(tickPayload && tickPayload.ok === true, 'tick should pass');
  assert.strictEqual(tickPayload.apply_requested, true);
  assert.strictEqual(tickPayload.apply, false, 'shadow mode should block live apply');
  assert.ok(Array.isArray(tickPayload.triggers) && tickPayload.triggers.includes('queue_backlog'));
  assert.ok(Number(tickPayload.activation_count || 0) >= 1, 'tick should schedule activations');

  const tickSkipped = run(['tick', '--source=unit_test'], env);
  assert.strictEqual(tickSkipped.status, 0, tickSkipped.stderr || tickSkipped.stdout);
  const skippedPayload = parseJson(tickSkipped.stdout);
  assert.ok(skippedPayload && skippedPayload.ok === true, 'second tick should still return ok');
  assert.strictEqual(skippedPayload.skipped, true, 'second tick should respect min interval');
  assert.strictEqual(skippedPayload.reason, 'min_tick_interval');

  const status = run(['status'], env);
  assert.strictEqual(status.status, 0, status.stderr || status.stdout);
  const statusPayload = parseJson(status.stdout);
  assert.ok(statusPayload && statusPayload.ok === true, 'status should pass');
  assert.strictEqual(Number(statusPayload.queue_depth), 0, 'queue should be consumed after tick');
  assert.ok(Number(statusPayload.tick_count || 0) >= 1, 'tick count should increment');

  console.log('background_persistent_agent_runtime.test.js: OK');
} catch (err) {
  console.error(`background_persistent_agent_runtime.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
