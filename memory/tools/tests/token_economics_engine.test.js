#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'token_economics_engine.js');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeJsonl(filePath, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const body = rows.map((row) => JSON.stringify(row)).join('\n');
  fs.writeFileSync(filePath, `${body}\n`, 'utf8');
}

function run(args) {
  const res = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  return {
    status: typeof res.status === 'number' ? res.status : 1,
    stdout: String(res.stdout || ''),
    stderr: String(res.stderr || '')
  };
}

function parseJson(stdout) {
  return JSON.parse(String(stdout || '').trim());
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'token-econ-engine-'));
  const policyPath = path.join(tmp, 'config', 'token_economics_engine_policy.json');
  const workflowHistoryPath = path.join(tmp, 'state', 'adaptive', 'workflows', 'executor', 'history.jsonl');
  const statePath = path.join(tmp, 'state', 'ops', 'token_economics_engine.json');
  const historyPath = path.join(tmp, 'state', 'ops', 'token_economics_engine_history.jsonl');

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    rolling_runs: 10,
    max_defer_ratio: 0.3,
    max_autopause_preflight_ratio: 0.2,
    max_predicted_tokens_per_run: 2000,
    base_throttle_ratio: 0.85,
    min_critical_lane_share: 0.2,
    paths: {
      workflow_history: workflowHistoryPath,
      state: statePath,
      history: historyPath
    }
  });

  writeJsonl(workflowHistoryPath, [
    {
      ts: '2026-02-26T00:00:00.000Z',
      token_economics: {
        predicted_total_tokens: 1800,
        run_token_cap_tokens: 2200,
        deferred_count: 0,
        deferred_by_reason: {}
      }
    },
    {
      ts: '2026-02-26T01:00:00.000Z',
      token_economics: {
        predicted_total_tokens: 1900,
        run_token_cap_tokens: 2200,
        deferred_count: 1,
        deferred_by_reason: {
          budget_autopause_active_preflight: 1
        }
      }
    }
  ]);

  let out = run(['run', '--policy=' + policyPath]);
  assert.strictEqual(out.status, 0, `run should succeed: ${out.stderr}`);
  let payload = parseJson(out.stdout);
  assert.strictEqual(payload.ok, true, 'payload should be ok');
  assert.strictEqual(payload.decision, 'throttle', 'autopause/defer pressure should trigger throttle');
  assert.ok(Array.isArray(payload.blockers) && payload.blockers.length > 0, 'throttle should emit blockers');
  assert.ok(payload.recommendations && payload.recommendations.queue_mode === 'defer_non_critical', 'throttle should recommend defer mode');

  out = run(['run', '--policy=' + policyPath, '--strict=1']);
  assert.strictEqual(out.status, 1, 'strict run should fail process on throttle decision');

  writeJsonl(workflowHistoryPath, [
    {
      ts: '2026-02-26T02:00:00.000Z',
      token_economics: {
        predicted_total_tokens: 900,
        run_token_cap_tokens: 2200,
        deferred_count: 0,
        deferred_by_reason: {}
      }
    },
    {
      ts: '2026-02-26T03:00:00.000Z',
      token_economics: {
        predicted_total_tokens: 1100,
        run_token_cap_tokens: 2200,
        deferred_count: 0,
        deferred_by_reason: {}
      }
    }
  ]);

  out = run(['run', '--policy=' + policyPath]);
  assert.strictEqual(out.status, 0, `healthy run should pass: ${out.stderr}`);
  payload = parseJson(out.stdout);
  assert.strictEqual(payload.decision, 'allow', 'healthy profile should allow execution');
  assert.strictEqual(payload.recommendations.queue_mode, 'normal', 'healthy profile should keep queue in normal mode');
  assert.ok(fs.existsSync(statePath), 'state artifact should be written');
  assert.ok(fs.existsSync(historyPath), 'history artifact should be written');

  console.log('token_economics_engine.test.js: OK');
} catch (err) {
  console.error(`token_economics_engine.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

