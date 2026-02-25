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

function parsePayload(stdout) {
  const raw = String(stdout || '').trim();
  try { return JSON.parse(raw); } catch {}
  const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function run() {
  const root = path.resolve(__dirname, '..', '..', '..');
  const scriptPath = path.join(root, 'systems', 'strategy', 'strategy_principles.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'strategy-principles-'));
  const strategyDir = path.join(tmp, 'config', 'strategies');
  const outDir = path.join(tmp, 'state', 'adaptive', 'strategy', 'principles');
  const dateStr = '2026-02-25';

  writeJson(path.join(strategyDir, 'default.json'), {
    version: '1.0',
    id: 'test_strategy',
    name: 'Test Strategy',
    status: 'active',
    objective: {
      primary: 'Increase verified autonomous progress while preserving rollback safety.'
    },
    risk_policy: {
      allowed_risks: ['low', 'medium'],
      max_risk_per_action: 55
    },
    ranking_weights: {
      composite: 0.34,
      actionability: 0.2,
      directive_fit: 0.16,
      signal_quality: 0.15,
      expected_value: 0.1,
      risk_penalty: 0.05
    },
    budget_policy: {
      daily_runs_cap: 4,
      daily_token_cap: 4000,
      max_tokens_per_action: 1500
    },
    promotion_policy: {
      min_success_criteria_receipts: 2,
      min_success_criteria_pass_rate: 0.65
    }
  });

  const env = {
    ...process.env,
    AUTONOMY_STRATEGY_DIR: strategyDir,
    STRATEGY_PRINCIPLES_OUT_DIR: outDir
  };

  const runProc = spawnSync(process.execPath, [scriptPath, 'run', dateStr], {
    cwd: root,
    encoding: 'utf8',
    env
  });
  assert.strictEqual(runProc.status, 0, runProc.stderr || 'run should pass');
  const runOut = parsePayload(runProc.stdout);
  assert.ok(runOut && runOut.ok === true, 'run output should be ok');
  assert.strictEqual(runOut.strategy_id, 'test_strategy');
  assert.ok(Number(runOut.score || 0) > 0.6, 'principles score should be above threshold');

  const latestPath = path.join(outDir, 'latest.json');
  assert.ok(fs.existsSync(latestPath), 'latest snapshot should exist');
  const latest = JSON.parse(fs.readFileSync(latestPath, 'utf8'));
  assert.ok(Array.isArray(latest.principles), 'principles array should exist');
  assert.ok(latest.principles.length >= 4, 'expected multiple principles');

  const statusProc = spawnSync(process.execPath, [scriptPath, 'status', 'latest'], {
    cwd: root,
    encoding: 'utf8',
    env
  });
  assert.strictEqual(statusProc.status, 0, statusProc.stderr || 'status should pass');
  const statusOut = parsePayload(statusProc.stdout);
  assert.ok(statusOut && statusOut.ok === true, 'status should be ok');
  assert.strictEqual(statusOut.strategy_id, 'test_strategy');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('strategy_principles.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`strategy_principles.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
