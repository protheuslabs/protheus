#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'finance', 'agent_settlement_extension.js');

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function parsePayload(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function run(args, env = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8'
  });
  return { status: Number(r.status || 0), payload: parsePayload(r.stdout), stderr: String(r.stderr || '') };
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-settlement-test-'));
  const policyPath = path.join(tmp, 'policy.json');
  writeJson(policyPath, {
    enabled: true,
    escrow_required_threshold_usd: 50,
    max_fee_rate: 0.05,
    receipts_path: path.join(tmp, 'state', 'receipts.jsonl'),
    ledger_path: path.join(tmp, 'state', 'ledger.json'),
    latest_path: path.join(tmp, 'state', 'latest.json')
  });
  const env = { AGENT_SETTLEMENT_EXTENSION_POLICY_PATH: policyPath };

  let r = run(['settle', '--settlement-id=s1', '--amount-usd=75', '--fee-rate=0.02', '--counterparty=agent_b'], env);
  assert.strictEqual(r.status, 0, `settle should pass: ${r.stderr}`);
  assert.ok(r.payload && r.payload.ok === true, 'settle should be ok');
  assert.strictEqual(r.payload.settlement.status, 'held_in_escrow', 'escrow status expected');

  r = run(['status'], env);
  assert.strictEqual(r.status, 0, `status should pass: ${r.stderr}`);
  assert.ok(r.payload && r.payload.ok === true, 'status should be ok');
  assert.strictEqual(r.payload.totals.entries, 1, 'one entry expected');

  console.log('agent_settlement_extension.test.js: OK');
}

try { main(); } catch (err) {
  console.error(`agent_settlement_extension.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
