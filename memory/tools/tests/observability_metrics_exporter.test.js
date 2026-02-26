#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'observability', 'metrics_exporter.js');

function mkdirp(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeJson(filePath, obj) {
  mkdirp(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
}

function run(args) {
  const res = spawnSync('node', [SCRIPT, ...args], {
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
  return JSON.parse(String(stdout || '{}').trim());
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'metrics-exporter-'));
  const state = path.join(tmp, 'state');
  const config = path.join(tmp, 'config');
  const policyPath = path.join(config, 'observability_policy.json');
  const dateStr = '2026-02-26';

  writeJson(path.join(state, 'autonomy', 'health_reports', `${dateStr}.daily.json`), {
    slo: {
      level: 'warn',
      warn_count: 2,
      critical_count: 1,
      failed_checks: ['loop_stall'],
      checks: {
        verification_pass_rate: {
          metrics: { verified_rate: 0.75 }
        }
      }
    },
    branch_health: {
      queue: { open_count: 11 },
      policy_holds: { count: 3 }
    },
    observed: { autonomy_runs: 7 }
  });

  writeJson(path.join(state, 'adaptive', 'workflows', 'executor', 'latest.json'), {
    slo: {
      pass: true,
      measured: {
        execution_success_rate: 1,
        queue_drain_rate: 0.8
      }
    }
  });

  writeJson(path.join(state, 'ops', 'ci_baseline_streak.json'), {
    target_days: 7,
    consecutive_daily_green_runs: 3
  });
  writeJson(path.join(state, 'ops', 'execution_reliability_slo.json'), {
    pass: true,
    measured: {
      execution_success_rate: 0.98,
      queue_drain_rate: 0.91,
      time_to_first_execution_p95_ms: 85000,
      zero_shipped_streak_days: 1
    }
  });
  writeJson(path.join(state, 'ops', 'ci_baseline_guard.json'), {
    pass: false,
    checks: {
      streak_target_met: false
    }
  });
  writeJson(path.join(state, 'ops', 'rm_progress_dashboard.json'), {
    status: {
      all_pass: false,
      pass_ratio: 0.667
    },
    blocked_by: ['rm001_ci_baseline_guard']
  });
  writeJson(path.join(state, 'ops', 'alert_transport_health.json'), {
    pass: true,
    rolling: {
      success_rate: 1,
      delivered: 24,
      failed: 0
    }
  });

  writeJson(policyPath, {
    version: '1.0-test',
    metrics: {
      enabled: true,
      write_prometheus: true,
      write_snapshot: true,
      health_reports_dir: path.join(state, 'autonomy', 'health_reports'),
      workflow_executor_latest_path: path.join(state, 'adaptive', 'workflows', 'executor', 'latest.json'),
      execution_reliability_slo_path: path.join(state, 'ops', 'execution_reliability_slo.json'),
      ci_baseline_guard_path: path.join(state, 'ops', 'ci_baseline_guard.json'),
      alert_transport_health_path: path.join(state, 'ops', 'alert_transport_health.json'),
      rm_progress_dashboard_path: path.join(state, 'ops', 'rm_progress_dashboard.json'),
      ci_baseline_streak_path: path.join(state, 'ops', 'ci_baseline_streak.json'),
      output_prometheus_path: path.join(state, 'observability', 'prometheus', 'current.prom'),
      output_snapshot_path: path.join(state, 'observability', 'metrics', 'latest.json'),
      output_history_jsonl_path: path.join(state, 'observability', 'metrics', 'history.jsonl')
    }
  });

  const runRes = run(['run', dateStr, '--window=daily', `--policy=${policyPath}`]);
  assert.strictEqual(runRes.status, 0, `run should pass: ${runRes.stderr}`);
  const payload = parseJson(runRes.stdout);
  assert.strictEqual(payload.ok, true, 'payload ok expected');
  assert.ok(Number(payload.metrics_count || 0) >= 10, 'expected metric count');
  assert.strictEqual(payload.health_report_found, true, 'health report should be found');

  const promPath = path.join(state, 'observability', 'prometheus', 'current.prom');
  const promText = fs.readFileSync(promPath, 'utf8');
  assert.ok(promText.includes('protheus_health_slo_level'), 'prometheus should include health metric');
  assert.ok(promText.includes('protheus_ci_baseline_streak_days'), 'prometheus should include ci streak metric');
  assert.ok(promText.includes('protheus_alert_transport_health_pass'), 'prometheus should include alert transport metric');
  assert.ok(promText.includes('protheus_rm_progress_dashboard_all_pass'), 'prometheus should include rm dashboard metric');

  const promRes = run(['prom', dateStr, '--window=daily', `--policy=${policyPath}`, '--write=0']);
  assert.strictEqual(promRes.status, 0, `prom should pass: ${promRes.stderr}`);
  assert.ok(promRes.stdout.includes('protheus_workflow_executor_slo_pass'), 'prom command should print text format');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('observability_metrics_exporter.test.js: OK');
} catch (err) {
  console.error(`observability_metrics_exporter.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
