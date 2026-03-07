#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'redteam', 'quantum_security_primitive_synthesis.js');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function appendJsonl(filePath, row) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function parseJson(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function run(args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  return {
    status: r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    payload: parseJson(r.stdout)
  };
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'quantum-synthesis-'));
  try {
    const policyPath = path.join(tmp, 'config', 'quantum_security_primitive_synthesis_policy.json');
    const venomHistoryPath = path.join(tmp, 'state', 'security', 'venom_containment', 'history.jsonl');
    const redHistoryPath = path.join(tmp, 'state', 'security', 'red_team', 'adaptive_defense', 'history.jsonl');
    const root = path.join(tmp, 'state', 'security', 'red_team', 'quantum_security_synthesis');
    const statePath = path.join(root, 'state.json');
    const latestPath = path.join(root, 'latest.json');
    const receiptsPath = path.join(root, 'receipts.jsonl');
    const queuePath = path.join(root, 'proposal_queue.json');
    const catalogPath = path.join(root, 'catalog.json');

    const now = new Date().toISOString();
    for (let i = 0; i < 8; i += 1) {
      appendJsonl(venomHistoryPath, {
        ts: now,
        type: 'venom_containment_evaluation',
        status: i % 2 === 0 ? 'unauthorized_probe' : 'containment_lockout',
        unauthorized: true
      });
      appendJsonl(redHistoryPath, {
        ts: now,
        type: 'adaptive_defense_cycle',
        outcome: i % 2 === 0 ? 'critical_probe_detected' : 'threat_pressure_rise',
        high_risk: i % 2 === 0
      });
    }

    writeJson(policyPath, {
      version: '1.0',
      enabled: true,
      shadow_only: false,
      defensive_only: true,
      bounded_only: true,
      auditable_only: true,
      min_containment_uplift_per_cycle: 0.2,
      max_proposals_per_cycle: 5,
      threat_window_days: 14,
      categories: ['hashing', 'signing', 'kem', 'attestation', 'watermark'],
      paths: {
        venom_history_path: venomHistoryPath,
        redteam_history_path: redHistoryPath,
        state_path: statePath,
        latest_path: latestPath,
        receipts_path: receiptsPath,
        proposal_queue_path: queuePath,
        catalog_path: catalogPath
      }
    });

    let res = run(['run', '--apply=1', `--policy=${policyPath}`]);
    assert.strictEqual(res.status, 0, `run should pass: ${res.stderr}`);
    assert.ok(res.payload && res.payload.ok === true, 'run payload should be ok');
    assert.strictEqual(res.payload.apply_allowed, true, 'apply should be allowed');
    assert.ok(Number(res.payload.proposals_generated || 0) >= 1, 'run should generate proposals');
    assert.ok(Number(res.payload.proposals_accepted || 0) >= 1, 'run should accept proposals');
    assert.ok(Number(res.payload.promoted || 0) >= 1, 'run should promote accepted proposals');
    assert.strictEqual(res.payload.uplift_goal_met, true, 'run should meet uplift goal');

    res = run(['verify', '--strict=1', `--policy=${policyPath}`]);
    assert.strictEqual(res.status, 0, `verify strict should pass: ${res.stderr}`);
    assert.ok(res.payload && res.payload.ok === true, 'verify payload should be ok');
    assert.ok(res.payload.checks && res.payload.checks.defensive_only === true, 'verify should enforce defensive-only');
    assert.ok(res.payload.checks && res.payload.checks.bounded_only === true, 'verify should enforce bounded-only');
    assert.ok(res.payload.checks && res.payload.checks.auditable_only === true, 'verify should enforce auditable-only');

    res = run(['status', `--policy=${policyPath}`]);
    assert.strictEqual(res.status, 0, `status should pass: ${res.stderr}`);
    assert.ok(res.payload && res.payload.ok === true, 'status payload should be ok');
    assert.ok(res.payload.state && Number(res.payload.state.cycles || 0) >= 1, 'state should record cycles');
    assert.ok(Array.isArray(res.payload.queue && res.payload.queue.proposals), 'status should include proposal queue');

    const queue = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
    const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
    assert.ok(Array.isArray(queue.proposals) && queue.proposals.length >= 1, 'proposal queue should persist proposals');
    assert.ok(Array.isArray(catalog.promoted) && catalog.promoted.length >= 1, 'catalog should persist promoted primitives');

    const receiptLines = fs.readFileSync(receiptsPath, 'utf8').split('\n').filter(Boolean);
    assert.ok(receiptLines.length >= 2, 'expected run + verify receipts');

    console.log('quantum_security_primitive_synthesis.test.js: OK');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

try {
  main();
} catch (err) {
  console.error(`quantum_security_primitive_synthesis.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
