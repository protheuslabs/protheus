#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'weaver', 'drift_aware_revenue_optimizer.js');

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function writeJsonl(filePath, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-aware-revenue-optimizer-'));
  const policyPath = path.join(tmp, 'drift_aware_revenue_optimizer_policy.json');
  const sloPath = path.join(tmp, 'state', 'ops', 'execution_reliability_slo.json');
  const hvLatestPath = path.join(tmp, 'state', 'adaptive', 'workflows', 'high_value_play', 'latest.json');
  const hvHistoryPath = path.join(tmp, 'state', 'adaptive', 'workflows', 'high_value_play', 'history.jsonl');
  const latestPath = path.join(tmp, 'state', 'weaver', 'drift_aware_revenue_optimizer', 'latest.json');
  const historyPath = path.join(tmp, 'state', 'weaver', 'drift_aware_revenue_optimizer', 'history.jsonl');
  const receiptsPath = path.join(tmp, 'state', 'weaver', 'drift_aware_revenue_optimizer', 'receipts.jsonl');

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    strict_default: false,
    drift_cap_30d: 0.02,
    require_execution_slo_pass: true,
    execution_reliability_state_path: sloPath,
    high_value_latest_path: hvLatestPath,
    high_value_history_path: hvHistoryPath,
    latest_path: latestPath,
    history_path: historyPath,
    receipts_path: receiptsPath
  });
  const env = { DRIFT_AWARE_REVENUE_OPTIMIZER_POLICY_PATH: policyPath };

  writeJson(sloPath, { pass: false });
  writeJson(hvLatestPath, {
    top_candidates: [
      { drift_risk: 0.7, reward_potential: 0.9, confidence: 0.8 }
    ]
  });
  writeJsonl(hvHistoryPath, [
    { type: 'high_value_play_outcome', ts: new Date().toISOString(), drift_risk: 0.05 }
  ]);

  const conservative = run(['optimize'], env);
  assert.strictEqual(conservative.status, 0, conservative.stderr || 'conservative optimize should pass');
  const conservativePayload = parseJson(conservative.stdout);
  assert.ok(conservativePayload && conservativePayload.ok === false, 'expected fail envelope');
  assert.strictEqual(conservativePayload.plan.mode, 'conservative', 'expected conservative mode');

  writeJson(sloPath, { pass: true });
  writeJson(hvLatestPath, {
    top_candidates: [
      { drift_risk: 0.01, reward_potential: 0.8, confidence: 0.8 },
      { drift_risk: 0.015, reward_potential: 0.75, confidence: 0.72 }
    ]
  });
  writeJsonl(hvHistoryPath, [
    { type: 'high_value_play_outcome', ts: new Date().toISOString(), drift_risk: 0.01 },
    { type: 'high_value_play_outcome', ts: new Date().toISOString(), drift_risk: 0.015 }
  ]);

  const balanced = run(['optimize', '--strict=1'], env);
  assert.strictEqual(balanced.status, 0, balanced.stderr || 'balanced optimize should pass strict');
  const balancedPayload = parseJson(balanced.stdout);
  assert.ok(balancedPayload && balancedPayload.ok === true, 'expected healthy envelope');
  assert.strictEqual(balancedPayload.plan.mode, 'balanced_growth', 'expected balanced growth mode');

  const status = run(['status', '--days=30'], env);
  assert.strictEqual(status.status, 0, status.stderr || 'status should pass');
  const statusPayload = parseJson(status.stdout);
  assert.ok(statusPayload && statusPayload.ok === true, 'status payload should be ok');
  assert.ok(Number(statusPayload.window_runs || 0) >= 2, 'history window should include optimize runs');

  console.log('drift_aware_revenue_optimizer.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`drift_aware_revenue_optimizer.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
