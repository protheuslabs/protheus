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

function writeJsonl(filePath, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');
}

function parsePayload(stdout) {
  const raw = String(stdout || '').trim();
  assert.ok(raw, 'expected stdout');
  try { return JSON.parse(raw); } catch {}
  const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  throw new Error('unable to parse json payload');
}

function runCli(scriptPath, args, cwd) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd,
    encoding: 'utf8'
  });
}

function run() {
  const root = path.resolve(__dirname, '..', '..', '..');
  const scriptPath = path.join(root, 'systems', 'autonomy', 'inversion_readiness_cert.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'inversion-readiness-cert-'));

  const inversionPolicyPath = path.join(tmp, 'config', 'inversion_policy.json');
  const receiptsPath = path.join(tmp, 'state', 'autonomy', 'inversion', 'receipts.jsonl');
  const historyPath = path.join(tmp, 'state', 'autonomy', 'inversion', 'history.jsonl');
  const latestPath = path.join(tmp, 'state', 'autonomy', 'inversion', 'latest.json');
  const activationPath = path.join(tmp, 'state', 'autonomy', 'inversion', 'live_activation_receipt.json');
  const outLatestPath = path.join(tmp, 'state', 'autonomy', 'inversion', 'readiness', 'latest.json');
  const outHistoryPath = path.join(tmp, 'state', 'autonomy', 'inversion', 'readiness', 'history.jsonl');
  const policyPath = path.join(tmp, 'config', 'inversion_readiness_policy.json');

  writeJson(inversionPolicyPath, {
    runtime: { mode: 'test' },
    tier_transition: {
      enabled: true,
      first_live_uses_require_human_veto: {
        tactical: 0,
        belief: 4,
        identity: 8
      }
    }
  });
  writeJsonl(receiptsPath, [
    { type: 'inversion_maturity_test', note: 'harness:imh-01:auto' },
    { type: 'inversion_maturity_test', note: 'harness:imh-02:auto' },
    { type: 'inversion_maturity_test', note: 'harness:imh-03:auto' }
  ]);
  writeJsonl(historyPath, [
    { ts: '2026-02-26T00:00:00.000Z', reasons: [] }
  ]);
  writeJson(latestPath, { ok: true });
  writeJson(policyPath, {
    enabled: true,
    required_harness_tests: ['imh-01', 'imh-02', 'imh-03'],
    paths: {
      inversion_policy: inversionPolicyPath,
      receipts: receiptsPath,
      history: historyPath,
      latest_state: latestPath,
      activation_receipt: activationPath,
      out_latest: outLatestPath,
      out_history: outHistoryPath
    }
  });

  let r = runCli(scriptPath, ['run', `--policy=${policyPath}`], root);
  assert.strictEqual(r.status, 0, `readiness run should return payload: ${r.stderr}`);
  let out = parsePayload(r.stdout);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.ready, false, 'without activation receipt, readiness should be false');
  assert.ok(Array.isArray(out.blockers) && out.blockers.includes('live_activation_receipt_missing'));

  r = runCli(
    scriptPath,
    [
      'approve-activation',
      `--policy=${policyPath}`,
      '--approved-by=jay',
      '--approval-note=manual_go_live_authorization'
    ],
    root
  );
  assert.strictEqual(r.status, 0, `approve-activation should succeed: ${r.stderr}`);
  out = parsePayload(r.stdout);
  assert.strictEqual(out.ok, true, 'approve-activation should emit ok');

  const activationReceipt = JSON.parse(fs.readFileSync(activationPath, 'utf8'));
  assert.strictEqual(activationReceipt.approved, true, 'activation receipt should be approved');
  assert.strictEqual(activationReceipt.approved_by, 'jay', 'activation receipt should capture approver');

  r = runCli(scriptPath, ['run', `--policy=${policyPath}`], root);
  assert.strictEqual(r.status, 0, `readiness run with activation receipt should pass: ${r.stderr}`);
  out = parsePayload(r.stdout);
  assert.strictEqual(out.ready, true, 'activation receipt should clear blocker');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('inversion_readiness_cert.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`inversion_readiness_cert.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
