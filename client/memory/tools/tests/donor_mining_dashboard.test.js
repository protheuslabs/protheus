#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const DASHBOARD_SCRIPT = path.join(ROOT, 'systems', 'economy', 'donor_mining_dashboard.js');
const CTL_SCRIPT = path.join(ROOT, 'systems', 'ops', 'protheusctl.js');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function appendJsonl(filePath, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');
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

function run(script, args) {
  const proc = spawnSync(process.execPath, [script, ...args], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  return {
    status: Number.isFinite(proc.status) ? Number(proc.status) : 1,
    stdout: String(proc.stdout || ''),
    stderr: String(proc.stderr || ''),
    payload: parseJson(proc.stdout)
  };
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'donor-dashboard-'));
  const policyPath = path.join(tmp, 'config', 'donor_mining_dashboard_policy.json');
  const contributionsPath = path.join(tmp, 'state', 'economy', 'contributions.json');
  const donorStatePath = path.join(tmp, 'state', 'economy', 'donor_state.json');
  const receiptsPath = path.join(tmp, 'state', 'economy', 'receipts.jsonl');
  const latestPath = path.join(tmp, 'state', 'economy', 'mining_dashboard', 'latest.json');
  const historyPath = path.join(tmp, 'state', 'economy', 'mining_dashboard', 'history.jsonl');
  const rollbackPath = path.join(tmp, 'state', 'economy', 'mining_dashboard', 'rollbacks.jsonl');

  writeJson(contributionsPath, [
    {
      contribution_id: 'c1',
      donor_id: 'alice',
      gpu_hours: 10,
      status: 'validated',
      received_at: new Date(Date.now() - 3 * 86400000).toISOString()
    },
    {
      contribution_id: 'c2',
      donor_id: 'alice',
      gpu_hours: 4,
      status: 'settled',
      received_at: new Date(Date.now() - 1 * 86400000).toISOString()
    },
    {
      contribution_id: 'c3',
      donor_id: 'bob',
      gpu_hours: 5,
      status: 'validated',
      received_at: new Date(Date.now() - 2 * 86400000).toISOString()
    },
    {
      contribution_id: 'c4',
      donor_id: 'bob',
      gpu_hours: 1,
      status: 'received',
      received_at: new Date(Date.now() - 1 * 86400000).toISOString()
    }
  ]);

  writeJson(donorStatePath, {
    alice: {
      donor_id: 'alice',
      total_validated_gpu_hours: 14,
      discount_rate: 0.05,
      effective_tithe_rate: 0.08
    },
    bob: {
      donor_id: 'bob',
      total_validated_gpu_hours: 5,
      discount_rate: 0.02,
      effective_tithe_rate: 0.09
    }
  });

  appendJsonl(receiptsPath, [
    { type: 'compute_tithe_receipt', payload: { donor_id: 'alice' } },
    { type: 'compute_tithe_receipt', payload: { donor_id: 'alice' } },
    { type: 'compute_tithe_receipt', payload: { donor_id: 'bob' } }
  ]);

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    flops_per_gpu_hour: 1000,
    reward_units_per_gpu_hour: 2,
    settled_reward_ratio_default: 0.75,
    projection: {
      short_days: 7,
      mid_days: 30,
      long_days: 90,
      low_factor: 0.8,
      high_factor: 1.2
    },
    accepted_statuses: ['validated', 'settled'],
    paths: {
      contributions_path: contributionsPath,
      donor_state_path: donorStatePath,
      receipts_path: receiptsPath,
      latest_path: latestPath,
      history_path: historyPath,
      rollback_log_path: rollbackPath
    }
  });

  let out = run(DASHBOARD_SCRIPT, ['dashboard', '--strict=1', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.strictEqual(out.payload.ok, true, 'dashboard should succeed');
  assert.strictEqual(out.payload.donor_count, 2, 'should include two donors');
  const alice = out.payload.donors.find((row) => row.donor_id === 'alice');
  assert.ok(alice, 'alice row missing');
  assert.strictEqual(alice.donor_flops, 14000, 'alice flops mismatch');
  assert.strictEqual(alice.accepted_work_units, 2, 'alice accepted work units mismatch');

  out = run(DASHBOARD_SCRIPT, ['dashboard', '--strict=1', '--donor=alice', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.strictEqual(out.payload.donor_count, 1, 'donor filter should narrow output');

  out = run(DASHBOARD_SCRIPT, ['rollback', '--reason=manual_audit', '--actor=tester', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.strictEqual(out.payload.ok, true, 'rollback event should record');

  out = run(CTL_SCRIPT, ['mine', 'dashboard', '--strict=1', '--donor=bob', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.ok === true, 'protheusctl mine dashboard should route to dashboard lane');

  out = run(DASHBOARD_SCRIPT, ['status', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.latest, 'status should include latest snapshot');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('donor_mining_dashboard.test.js: OK');
} catch (err) {
  console.error(`donor_mining_dashboard.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
