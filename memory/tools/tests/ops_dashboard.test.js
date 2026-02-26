#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'autonomy', 'ops_dashboard.js');

function mkdirp(p) { fs.mkdirSync(p, { recursive: true }); }
function writeJson(p, obj) { mkdirp(path.dirname(p)); fs.writeFileSync(p, JSON.stringify(obj, null, 2)); }

function run(args, env) {
  const r = spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
  let payload = null;
  try { payload = JSON.parse(String(r.stdout || '').trim()); } catch {}
  return { status: r.status ?? 0, payload, stderr: String(r.stderr || '') };
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-dashboard-'));
  const reportsDir = path.join(tmp, 'reports');
  const workflowLatestPath = path.join(tmp, 'workflow', 'latest.json');
  const kpiLatestPath = path.join(tmp, 'kpi', 'latest.json');
  const kpiHistoryPath = path.join(tmp, 'kpi', 'history.jsonl');

  writeJson(path.join(reportsDir, '2026-02-21__daily.json'), {
    slo: {
      alert_level: 'warn',
      checks: [
        { name: 'dark_eye', pass: false },
        { name: 'proposal_starvation', pass: true },
        { name: 'loop_stall', pass: false },
        { name: 'drift', pass: true }
      ]
    },
    branch_health: {
      workers: { active_cells: 3 },
      leases: { active: 2 },
      queue: { open_count: 11 },
      cooldowns: { active: 1 },
      policy_holds: { count: 4 }
    }
  });

  writeJson(workflowLatestPath, {
    ok: true,
    workflows_executed: 2,
    workflows_succeeded: 2,
    workflows_failed: 0,
    slo: {
      measured: {
        execution_success_rate: 1,
        queue_drain_rate: 1,
        time_to_first_execution_ms: 10
      }
    }
  });

  const r = run(['run', '2026-02-21', '--days=1'], {
    AUTONOMY_HEALTH_REPORTS_DIR: reportsDir,
    AUTONOMY_OPS_WORKFLOW_EXECUTOR_LATEST_PATH: workflowLatestPath,
    AUTONOMY_OPS_KPI_LATEST_PATH: kpiLatestPath,
    AUTONOMY_OPS_KPI_HISTORY_PATH: kpiHistoryPath
  });
  assert.strictEqual(r.status, 0, `run should pass: ${r.stderr}`);
  assert.ok(r.payload && r.payload.ok === true, 'ok expected');
  assert.strictEqual(r.payload.summary.slo.dark_eye.fail, 1, 'dark_eye fail count expected');
  assert.strictEqual(r.payload.summary.slo.loop_stall.fail, 1, 'loop_stall fail count expected');
  assert.strictEqual(r.payload.summary.branch_health.queue_open_peak, 11, 'branch health should surface queue peak');
  assert.strictEqual(r.payload.summary.branch_health.active_cells_peak, 3, 'branch health should surface active cell peak');
  assert.strictEqual(r.payload.summary.branch_health.policy_holds_total, 4, 'branch health should aggregate policy holds');
  assert.ok(r.payload.kpi && r.payload.kpi.execution, 'kpi execution should exist');
  assert.strictEqual(Number(r.payload.kpi.execution.workflows_executed || 0), 2, 'kpi execution should read workflow latest');
  assert.ok(fs.existsSync(kpiLatestPath), 'kpi latest should be written');
  assert.ok(fs.existsSync(kpiHistoryPath), 'kpi history should be written');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('ops_dashboard.test.js: OK');
} catch (err) {
  console.error(`ops_dashboard.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
