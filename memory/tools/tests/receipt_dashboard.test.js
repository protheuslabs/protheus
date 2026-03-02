#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'autonomy', 'receipt_dashboard.js');

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
  const lines = text.split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-dashboard-'));
  const runsDir = path.join(tmp, 'state', 'autonomy', 'runs');
  const policyPath = path.join(tmp, 'config', 'receipt_dashboard_policy.json');
  const latestPath = path.join(tmp, 'state', 'autonomy', 'receipt_dashboard', 'latest.json');
  const historyPath = path.join(tmp, 'state', 'autonomy', 'receipt_dashboard', 'history.jsonl');
  const reportsDir = path.join(tmp, 'state', 'autonomy', 'receipt_dashboard', 'reports');

  writeJsonl(path.join(runsDir, '2026-03-02.jsonl'), [
    { type: 'autonomy_run', ts: '2026-03-02T09:00:00.000Z', result: 'execute_success' },
    { type: 'autonomy_run', ts: '2026-03-02T09:05:00.000Z', result: 'route_blocked_budget' },
    { type: 'autonomy_run', ts: '2026-03-02T09:15:00.000Z', success_criteria: { passed: true }, result: 'custom' },
    { type: 'autonomy_run', ts: '2026-03-02T09:20:00.000Z', success_criteria: { passed: false }, result: 'postcondition_failed' }
  ]);

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    paths: {
      runs_dir: runsDir,
      latest_path: latestPath,
      history_path: historyPath,
      reports_dir: reportsDir
    }
  });

  const env = {
    RECEIPT_DASHBOARD_ROOT: tmp,
    RECEIPT_DASHBOARD_POLICY_PATH: policyPath
  };

  let out = run(['daily', '--date=2026-03-02', '--days=1'], env);
  assert.strictEqual(out.status, 0, out.stderr || 'daily command should pass');
  const payload = parseJson(out.stdout);
  assert.ok(payload && payload.ok === true, 'payload should be ok');
  assert.strictEqual(Number(payload.summary.totals.evaluated || 0), 4, 'evaluated count mismatch');
  assert.strictEqual(Number(payload.summary.totals.passed || 0), 2, 'passed count mismatch');
  assert.strictEqual(Number(payload.summary.totals.failed || 0), 2, 'failed count mismatch');
  assert.ok(Number(payload.summary.totals.pass_rate || 0) === 0.5, 'pass rate should be 0.5');
  assert.ok(Array.isArray(payload.summary.top_failure_reasons) && payload.summary.top_failure_reasons.length >= 1, 'failure reasons missing');
  assert.ok(fs.existsSync(latestPath), 'latest output should exist');
  assert.ok(fs.existsSync(historyPath), 'history output should exist');

  out = run(['status'], env);
  assert.strictEqual(out.status, 0, out.stderr || 'status should pass');
  const statusPayload = parseJson(out.stdout);
  assert.ok(statusPayload && statusPayload.ok === true, 'status should be ok');
  assert.ok(statusPayload.latest && statusPayload.latest.type === 'autonomy_receipt_dashboard', 'status latest missing');

  console.log('receipt_dashboard.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`receipt_dashboard.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
