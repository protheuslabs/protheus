#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(REPO_ROOT, 'systems', 'autonomy', 'health_status.js');

function mkDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function writeJson(fp, obj) {
  mkDir(path.dirname(fp));
  fs.writeFileSync(fp, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
}

function writeJsonl(fp, rows) {
  mkDir(path.dirname(fp));
  const body = (rows || []).map((r) => JSON.stringify(r)).join('\n');
  fs.writeFileSync(fp, body ? `${body}\n` : '', 'utf8');
}

function writeStubScript(fp, payload) {
  mkDir(path.dirname(fp));
  const src = `#!/usr/bin/env node\nconsole.log(JSON.stringify(${JSON.stringify(payload)}));\n`;
  fs.writeFileSync(fp, src, 'utf8');
}

function runHealth(env, date) {
  const r = spawnSync('node', [SCRIPT, date, '--window=daily', '--days=1', '--write=1', '--alerts=1'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env }
  });
  assert.strictEqual(r.status, 0, `health_status should exit 0, got ${r.status}: ${r.stderr}`);
  const out = JSON.parse(String(r.stdout || '{}'));
  return out;
}

function main() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'health-status-test-'));
  const date = '2026-02-21';
  const nowIso = '2026-02-21T20:00:00.000Z';

  const stubsDir = path.join(tmpRoot, 'stubs');
  const stateDir = path.join(tmpRoot, 'state');
  const sensoryDir = path.join(stateDir, 'sensory');
  const proposalsDir = path.join(sensoryDir, 'proposals');
  const queueDecisionsDir = path.join(stateDir, 'queue', 'decisions');
  const runsDir = path.join(stateDir, 'autonomy', 'runs');
  const alertsDir = path.join(stateDir, 'autonomy', 'health_alerts');
  const reportsDir = path.join(stateDir, 'autonomy', 'health_reports');
  const budgetEventsPath = path.join(stateDir, 'autonomy', 'budget_events.jsonl');
  const budgetAutopausePath = path.join(stateDir, 'autonomy', 'budget_autopause.json');

  writeJson(path.join(sensoryDir, 'eyes', 'registry.json'), {
    eyes: [
      { id: 'good_eye', status: 'active', last_success: '2026-02-21T19:30:00.000Z', consecutive_failures: 0 },
      { id: 'dark_eye', status: 'active', last_success: '2026-02-20T00:00:00.000Z', consecutive_failures: 0 },
      { id: 'failing_eye', status: 'failing', last_success: '2026-02-21T17:00:00.000Z', consecutive_failures: 3 },
      { id: 'retired_eye', status: 'retired', last_success: '2026-02-19T00:00:00.000Z', consecutive_failures: 99 }
    ]
  });

  writeJson(path.join(proposalsDir, `${date}.json`), [
    { id: 'P1', meta: { admission_preview: { eligible: true } } },
    { id: 'P2', meta: { admission_preview: { eligible: true } } },
    { id: 'P3', meta: { admission_preview: { eligible: true } } },
    { id: 'P4', meta: { admission_preview: { eligible: true } } },
    { id: 'P5', meta: { admission_preview: { eligible: true } } },
    { id: 'P6', meta: { admission_preview: { eligible: true } } }
  ]);

  writeJsonl(path.join(queueDecisionsDir, '2026-02-19.jsonl'), [
    { ts: '2026-02-19T08:00:00.000Z', type: 'decision', proposal_id: 'P0', decision: 'accept', reason: 'old_progress' }
  ]);
  writeJsonl(path.join(queueDecisionsDir, `${date}.jsonl`), []);

  writeJsonl(path.join(runsDir, `${date}.jsonl`), []);

  writeJson(path.join(stateDir, 'spine', 'router_health.json'), {
    ts: '2026-02-21T19:59:00.000Z',
    consecutive_full_local_down: 2,
    last_preflight: { ok: false, local_total: 2, local_eligible: 0 }
  });

  writeJson(path.join(stateDir, 'routing', 'model_health.json'), {
    schema_version: 2,
    active_runtime: 'host',
    runtimes: {
      host: {
        'ollama/smallthinker': { model: 'ollama/smallthinker', available: false, checked_ms: Date.parse(nowIso) - 3600000 }
      }
    },
    records: {
      'ollama/smallthinker': { model: 'ollama/smallthinker', available: false, checked_ms: Date.parse(nowIso) - 3600000 }
    }
  });

  writeJson(path.join(stateDir, 'autonomy', 'cooldowns.json'), {});
  writeJsonl(path.join(stateDir, 'actuation', 'receipts', `${date}.jsonl`), []);
  writeJsonl(budgetEventsPath, []);
  writeJson(budgetAutopausePath, {
    schema_id: 'system_budget_autopause',
    schema_version: '1.0.0',
    active: false,
    source: 'health_status_test',
    reason: null,
    pressure: null,
    date: null,
    until_ms: 0,
    until: null,
    updated_at: nowIso
  });

  writeStubScript(path.join(stubsDir, 'autonomy_controller.js'), { ok: true, status: 'idle' });
  writeStubScript(path.join(stubsDir, 'receipt_summary.js'), {
    ok: true,
    runs: { total: 0, latest_event_ts: '2026-02-20T08:00:00.000Z' },
    receipts: {
      combined: {
        attempted: 12,
        verified: 10,
        verified_rate: 0.833,
        top_failure_reasons: {
          timeout: 1
        }
      }
    }
  });
  writeStubScript(path.join(stubsDir, 'strategy_doctor.js'), { ok: true, strategy: { id: 'default_general' } });
  writeStubScript(path.join(stubsDir, 'strategy_readiness.js'), {
    ok: true,
    readiness: { current_mode: 'canary_execute', ready_for_execute: true, failed_checks: [] }
  });
  writeStubScript(path.join(stubsDir, 'strategy_mode_governor.js'), {
    ok: true,
    strategy: { mode: 'execute' },
    canary: {
      metrics: {
        require_quality_lock_for_execute: true,
        quality_lock_active: false,
        quality_lock_stable_window_streak: 0
      }
    },
    policy: { canary_require_quality_lock_for_execute: true }
  });
  writeStubScript(path.join(stubsDir, 'architecture_guard.js'), { ok: true });
  writeStubScript(path.join(stubsDir, 'model_router.js'), {
    ok: true,
    tier1_local_decision: { escalate: true, reason: 'local_unavailable' },
    diagnostics: [
      { model: 'ollama/smallthinker', local: true, eligible: false, local_health: { source_runtime: 'host', stale: false } },
      { model: 'ollama/qwen3:4b', local: true, eligible: false, local_health: { source_runtime: 'host', stale: false } }
    ]
  });
  writeStubScript(path.join(stubsDir, 'pipeline_spc_gate.js'), {
    ok: true,
    pass: false,
    hold_escalation: true,
    failed_checks: ['attempted', 'stop_ratio'],
    control: { baseline_days: 21, sigma: 3 }
  });
  writeStubScript(path.join(stubsDir, 'integrity_kernel.js'), {
    ok: true,
    expected_files: 27,
    checked_present_files: 27,
    violations: [],
    violation_counts: {}
  });

  const env = {
    AUTONOMY_HEALTH_NOW_ISO: nowIso,
    AUTONOMY_HEALTH_AUTONOMY_CONTROLLER_SCRIPT: path.join(stubsDir, 'autonomy_controller.js'),
    AUTONOMY_HEALTH_RECEIPT_SUMMARY_SCRIPT: path.join(stubsDir, 'receipt_summary.js'),
    AUTONOMY_HEALTH_STRATEGY_DOCTOR_SCRIPT: path.join(stubsDir, 'strategy_doctor.js'),
    AUTONOMY_HEALTH_STRATEGY_READINESS_SCRIPT: path.join(stubsDir, 'strategy_readiness.js'),
    AUTONOMY_HEALTH_STRATEGY_MODE_GOVERNOR_SCRIPT: path.join(stubsDir, 'strategy_mode_governor.js'),
    AUTONOMY_HEALTH_ARCH_GUARD_SCRIPT: path.join(stubsDir, 'architecture_guard.js'),
    AUTONOMY_HEALTH_MODEL_ROUTER_SCRIPT: path.join(stubsDir, 'model_router.js'),
    AUTONOMY_HEALTH_PIPELINE_SPC_SCRIPT: path.join(stubsDir, 'pipeline_spc_gate.js'),
    AUTONOMY_HEALTH_INTEGRITY_KERNEL_SCRIPT: path.join(stubsDir, 'integrity_kernel.js'),
    AUTONOMY_HEALTH_EYES_REGISTRY_PATH: path.join(sensoryDir, 'eyes', 'registry.json'),
    AUTONOMY_HEALTH_PROPOSALS_DIR: proposalsDir,
    AUTONOMY_HEALTH_QUEUE_DECISIONS_DIR: queueDecisionsDir,
    AUTONOMY_HEALTH_AUTONOMY_RUNS_DIR: runsDir,
    AUTONOMY_HEALTH_SPINE_HEALTH_PATH: path.join(stateDir, 'spine', 'router_health.json'),
    AUTONOMY_HEALTH_ROUTING_MODEL_HEALTH_PATH: path.join(stateDir, 'routing', 'model_health.json'),
    AUTONOMY_HEALTH_COOLDOWNS_PATH: path.join(stateDir, 'autonomy', 'cooldowns.json'),
    AUTONOMY_HEALTH_ACTUATION_RECEIPTS_DIR: path.join(stateDir, 'actuation', 'receipts'),
    AUTONOMY_HEALTH_SYSTEM_BUDGET_EVENTS_PATH: budgetEventsPath,
    AUTONOMY_HEALTH_SYSTEM_BUDGET_AUTOPAUSE_PATH: budgetAutopausePath,
    AUTONOMY_HEALTH_ALERTS_DIR: alertsDir,
    AUTONOMY_HEALTH_REPORTS_DIR: reportsDir
  };

  const first = runHealth(env, date);
  assert.strictEqual(first.window, 'daily');
  assert.strictEqual(Number(first.window_days), 1);
  assert.ok(first.slo && first.slo.ok === false, 'slo should fail for this fixture');
  assert.ok(Array.isArray(first.slo.failed_checks) && first.slo.failed_checks.includes('dark_eyes'));
  assert.ok(first.slo.failed_checks.includes('proposal_starvation'));
  assert.ok(first.slo.failed_checks.includes('loop_stall'));
  assert.ok(first.slo.failed_checks.includes('drift'));
  assert.ok(first.slo.failed_checks.includes('routing_degraded'));
  assert.ok(first.slo.failed_checks.includes('execute_quality_lock_invariant'));
  assert.ok(first.slo.checks.dark_eyes, 'dark_eyes check should exist');
  assert.strictEqual(Number(first.slo.checks.dark_eyes.metrics.total_eyes || 0), 3, 'retired eyes should be excluded from dark-eye totals');
  assert.ok(!String(first.slo.checks.dark_eyes.reason || '').includes('retired_eye'), 'retired eye should not be listed as dark');
  assert.strictEqual(first.slo.failed_checks.includes('verification_pass_rate'), false, 'verification pass-rate should pass in fixture');
  assert.strictEqual(first.slo.failed_checks.includes('budget_guard'), false, 'budget guard should pass in fixture');
  assert.strictEqual(first.slo.failed_checks.includes('integrity'), false, 'integrity should pass in fixture');
  assert.strictEqual(Boolean(first.gates && first.gates.budget_autopause_active), false, 'budget autopause gate should be false in fixture');
  assert.ok(first.report && first.report.written === true && fs.existsSync(first.report.path), 'report should be written');
  assert.ok(first.alerts && fs.existsSync(first.alerts.path), 'alerts file should exist');
  assert.ok(Number(first.alerts.written || 0) >= 5, 'first run should emit multiple alerts');

  const alertLinesFirst = fs.readFileSync(first.alerts.path, 'utf8').split('\n').filter(Boolean).length;
  assert.strictEqual(alertLinesFirst, Number(first.alerts.total || 0), 'alert total should match file rows');

  const second = runHealth(env, date);
  const alertLinesSecond = fs.readFileSync(second.alerts.path, 'utf8').split('\n').filter(Boolean).length;
  assert.strictEqual(Number(second.alerts.written || 0), 0, 'second run should dedupe existing alerts');
  assert.strictEqual(alertLinesSecond, alertLinesFirst, 'second run should not append duplicate alerts');

  writeStubScript(path.join(stubsDir, 'pipeline_spc_gate.js'), {
    ok: true,
    pass: false,
    hold_escalation: true,
    failed_checks: ['stop_ratio'],
    current: {
      stop_ratio_source: 'quality',
      stop_ratio_denominator: 1
    },
    control: { baseline_days: 21, sigma: 3 }
  });
  const third = runHealth(env, date);
  assert.ok(third.slo && third.slo.checks && third.slo.checks.drift, 'drift check should exist');
  assert.strictEqual(Boolean(third.slo.checks.drift.ok), true, 'low-sample quality stop ratio should be non-blocking');
  assert.strictEqual(String(third.slo.checks.drift.reason || ''), 'spc_quality_stopratio_low_sample_nonblocking');

  writeStubScript(path.join(stubsDir, 'autonomy_controller.js'), { ok: true, autonomy_enabled: true, status: 'execute' });
  writeStubScript(path.join(stubsDir, 'receipt_summary.js'), {
    ok: true,
    runs: { total: 3, latest_event_ts: '2026-02-21T19:00:00.000Z' },
    receipts: {
      combined: {
        attempted: 12,
        verified: 4,
        verified_rate: 0.333,
        top_failure_reasons: {
          simulated_timeout: 4,
          simulated_rate_limited: 2
        }
      }
    }
  });
  const fourth = runHealth(env, date);
  assert.ok(fourth.slo && fourth.slo.checks && fourth.slo.checks.verification_pass_rate, 'verification pass-rate check should exist');
  assert.strictEqual(Boolean(fourth.slo.checks.verification_pass_rate.ok), false, 'verification pass-rate should fail when rate is critical');
  assert.strictEqual(String(fourth.slo.checks.verification_pass_rate.reason || ''), 'verification_pass_rate_critical');

  console.log('health_status.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`health_status.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
