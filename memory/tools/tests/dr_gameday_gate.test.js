#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'dr_gameday_gate.js');

function mkDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function writeText(filePath, body) {
  mkDir(path.dirname(filePath));
  fs.writeFileSync(filePath, body, 'utf8');
}

function appendJsonl(filePath, rows) {
  mkDir(path.dirname(filePath));
  const body = rows.map((row) => JSON.stringify(row)).join('\n');
  fs.writeFileSync(filePath, `${body}\n`, 'utf8');
}

function run(args, env) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...(env || {}) }
  });
  const out = String(r.stdout || '').trim();
  const lines = out.split('\n').map((x) => x.trim()).filter(Boolean);
  let payload = null;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      payload = JSON.parse(lines[i]);
      break;
    } catch {}
  }
  return { status: Number(r.status || 0), stdout: out, stderr: String(r.stderr || '').trim(), payload };
}

function mkDrRow({ ok = true, rto = 10, rpo = 2 }) {
  return {
    ok,
    type: 'dr_gameday',
    ts: new Date().toISOString(),
    metrics: { rto_minutes: rto, rpo_hours: rpo }
  };
}

function runTest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-gameday-gate-test-'));
  const policyPath = path.join(tmp, 'dr_policy.json');
  const receiptsPath = path.join(tmp, 'dr_receipts.jsonl');
  const gateReceipts = path.join(tmp, 'dr_gate_receipts.jsonl');

  writeText(policyPath, JSON.stringify({
    version: '1.0',
    release_gate: {
      window: 4,
      min_samples: 3,
      required_pass_rate: 1,
      max_rto_regression_ratio: 0.2,
      max_rpo_regression_ratio: 0.2,
      strict_default: true
    }
  }, null, 2));

  const env = {
    DR_GAMEDAY_POLICY_PATH: policyPath,
    DR_GAMEDAY_RECEIPTS_PATH: receiptsPath,
    DR_GAMEDAY_GATE_RECEIPTS_PATH: gateReceipts
  };

  try {
    appendJsonl(receiptsPath, [
      mkDrRow({ ok: true, rto: 8, rpo: 2 }),
      mkDrRow({ ok: true, rto: 9, rpo: 2.1 }),
      mkDrRow({ ok: true, rto: 9, rpo: 2.1 }),
      mkDrRow({ ok: true, rto: 10, rpo: 2.2 }),
      mkDrRow({ ok: true, rto: 10, rpo: 2.3 })
    ]);
    let r = run(['run', '--strict=1'], env);
    assert.strictEqual(r.status, 0, `gate should pass on healthy trend: ${r.stderr}`);
    assert.ok(r.payload && r.payload.ok === true, 'healthy trend should pass');

    appendJsonl(receiptsPath, [
      mkDrRow({ ok: true, rto: 18, rpo: 4 }),
      mkDrRow({ ok: false, rto: 20, rpo: 5 }),
      mkDrRow({ ok: true, rto: 19, rpo: 4.8 }),
      mkDrRow({ ok: true, rto: 21, rpo: 5.2 })
    ]);
    r = run(['run', '--strict=1', '--limit=8'], env);
    assert.notStrictEqual(r.status, 0, 'regression should fail strict gate');
    assert.ok(r.payload && r.payload.ok === false, 'payload should fail');
    assert.ok(
      Array.isArray(r.payload.evaluation && r.payload.evaluation.reasons)
      && r.payload.evaluation.reasons.length > 0,
      'expected at least one strict gate failure reason'
    );

    appendJsonl(receiptsPath, [mkDrRow({ ok: true, rto: 7, rpo: 1.5 })]);
    r = run(['run', '--strict=1', '--limit=1'], env);
    assert.strictEqual(r.status, 0, 'insufficient samples should not hard fail gate');
    assert.ok(r.payload && r.payload.ok === true, 'insufficient sample window should pass');
    assert.ok(
      Array.isArray(r.payload.evaluation && r.payload.evaluation.reasons)
      && r.payload.evaluation.reasons.includes('insufficient_recent_samples'),
      'insufficient sample reason expected'
    );

    console.log('dr_gameday_gate.test.js: OK');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

try {
  runTest();
} catch (err) {
  console.error(`dr_gameday_gate.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
