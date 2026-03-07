#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function writeFile(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text, 'utf8');
}

function writeJson(filePath, value) {
  writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function runNode(scriptPath, args, env, cwd) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd,
    env,
    encoding: 'utf8'
  });
}

function parseStdoutJson(proc) {
  const raw = String(proc.stdout || '').trim();
  assert.ok(raw, 'expected stdout payload');
  return JSON.parse(raw);
}

function makeContinuumLatest({ drift = 0.02, holdRate = 0.2, trit = 1, failed = 0, blocked = 0 }) {
  return {
    ok: true,
    type: 'continuum_pulse',
    ts: '2026-02-25T12:00:00.000Z',
    date: '2026-02-25',
    autonomy: {
      hold_rate: holdRate
    },
    simulation: {
      drift_rate: drift
    },
    trit: {
      value: trit,
      label: trit > 0 ? 'ok' : (trit < 0 ? 'pain' : 'unknown')
    },
    actions: [
      {
        id: 'autotest_validation',
        metrics: {
          failed,
          guard_blocked: blocked
        }
      }
    ]
  };
}

function run() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const scriptPath = path.join(repoRoot, 'systems', 'dual_brain', 'coordinator.js');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dual-brain-coordinator-'));
  const dateStr = '2026-02-25';

  const policyPath = path.join(tmpRoot, 'config', 'dual_brain_policy.json');
  const stateDir = path.join(tmpRoot, 'state', 'dual_brain');
  const continuumPath = path.join(tmpRoot, 'state', 'autonomy', 'continuum', 'latest.json');
  const budgetDir = path.join(tmpRoot, 'state', 'autonomy', 'daily_budget');
  const budgetAutopausePath = path.join(tmpRoot, 'state', 'autonomy', 'budget_autopause.json');
  const integrityPath = path.join(tmpRoot, 'state', 'security', 'integrity_violations.jsonl');
  const spineRunsDir = path.join(tmpRoot, 'state', 'spine', 'runs');

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    shadow_mode: true,
    left_brain: {
      id: 'left_standard',
      model: 'left-model',
      force_context_contains: ['identity', 'governance', 'contract', 'security', 'execution', 'spine'],
      force_task_classes: ['identity', 'governance', 'contract', 'security', 'execution', 'spine', 'critical']
    },
    right_brain: {
      enabled: true,
      id: 'right_creative',
      model: 'right-model',
      opportunistic_only: true,
      allowed_context_contains: ['orchestron', 'creative', 'dream'],
      allowed_task_classes: ['workflow_generation', 'creative', 'dream', 'training']
    },
    trit: {
      require_non_pain_for_right: true,
      min_right_trit: 0
    },
    thresholds: {
      hardware: {
        min_cpu_count: 1,
        max_load_per_cpu: 8,
        min_free_mem_mb: 32,
        max_process_rss_mb: 64000,
        max_process_heap_mb: 32000
      },
      budget: {
        require_budget_data: true,
        min_token_headroom_ratio: 0.2,
        max_burn_pct: 85,
        deny_when_autopause_active: true
      },
      stability: {
        max_effective_drift_rate: 0.035,
        max_policy_hold_rate: 0.5,
        max_autotest_failed_last: 0,
        max_autotest_guard_blocked_last: 0
      },
      safety: {
        block_on_integrity_alert_within_hours: 24,
        block_on_spine_critical: true
      }
    },
    training_gate: {
      enabled: true,
      max_load_per_cpu: 8,
      min_free_mem_mb: 32,
      min_token_headroom_ratio: 0.3
    },
    telemetry: {
      emit_events: true,
      max_reasons: 8
    }
  });

  writeJson(continuumPath, makeContinuumLatest({
    drift: 0.02,
    holdRate: 0.2,
    trit: 1,
    failed: 0,
    blocked: 0
  }));
  writeJson(path.join(budgetDir, `${dateStr}.json`), {
    schema_id: 'system_budget_state',
    schema_version: '1.0.0',
    date: dateStr,
    token_cap: 1000,
    used_est: 300,
    by_module: {},
    updated_at: '2026-02-25T12:00:00.000Z'
  });
  writeJson(budgetAutopausePath, {
    schema_id: 'system_budget_autopause',
    schema_version: '1.0.0',
    active: false,
    updated_at: '2026-02-25T12:00:00.000Z'
  });
  writeFile(integrityPath, '');
  writeFile(
    path.join(spineRunsDir, `${dateStr}.jsonl`),
    `${JSON.stringify({
      ts: '2026-02-25T12:00:00.000Z',
      type: 'spine_autonomy_health',
      slo_level: 'ok',
      critical_count: 0,
      warn_count: 0,
      failed_checks: []
    })}\n`
  );

  const env = {
    ...process.env,
    DUAL_BRAIN_POLICY_PATH: policyPath,
    DUAL_BRAIN_STATE_DIR: stateDir,
    DUAL_BRAIN_CONTINUUM_LATEST_PATH: continuumPath,
    DUAL_BRAIN_BUDGET_STATE_DIR: budgetDir,
    DUAL_BRAIN_BUDGET_AUTOPAUSE_PATH: budgetAutopausePath,
    DUAL_BRAIN_INTEGRITY_LOG_PATH: integrityPath,
    DUAL_BRAIN_SPINE_RUNS_DIR: spineRunsDir
  };

  const forcedLeft = runNode(scriptPath, [
    'route',
    '--context=identity.directive',
    '--task-class=identity',
    '--desired-lane=right',
    '--persist=0',
    `--date=${dateStr}`
  ], env, repoRoot);
  assert.strictEqual(forcedLeft.status, 0, forcedLeft.stderr || 'forced-left route should pass');
  const forcedOut = parseStdoutJson(forcedLeft);
  assert.strictEqual(forcedOut.mode, 'left_only');
  assert.ok(Array.isArray(forcedOut.reasons) && forcedOut.reasons.includes('left_priority_context'));

  const creativeAllowed = runNode(scriptPath, [
    'route',
    '--context=orchestron.creative_llm',
    '--task-class=workflow_generation',
    '--desired-lane=right',
    '--persist=0',
    `--date=${dateStr}`
  ], env, repoRoot);
  assert.strictEqual(creativeAllowed.status, 0, creativeAllowed.stderr || 'creative route should pass');
  const creativeOut = parseStdoutJson(creativeAllowed);
  assert.strictEqual(creativeOut.mode, 'left_live_right_shadow');
  assert.strictEqual(Boolean(creativeOut.right && creativeOut.right.permitted), true);

  writeJson(path.join(budgetDir, `${dateStr}.json`), {
    schema_id: 'system_budget_state',
    schema_version: '1.0.0',
    date: dateStr,
    token_cap: 1000,
    used_est: 950,
    by_module: {},
    updated_at: '2026-02-25T12:05:00.000Z'
  });
  const budgetDenied = runNode(scriptPath, [
    'route',
    '--context=orchestron.creative_llm',
    '--task-class=workflow_generation',
    '--desired-lane=right',
    '--persist=0',
    `--date=${dateStr}`
  ], env, repoRoot);
  assert.strictEqual(budgetDenied.status, 0, budgetDenied.stderr || 'budget denied route should pass');
  const budgetOut = parseStdoutJson(budgetDenied);
  assert.strictEqual(budgetOut.mode, 'left_only');
  assert.ok(
    Array.isArray(budgetOut.reasons)
      && (budgetOut.reasons.includes('budget_headroom_low') || budgetOut.reasons.includes('budget_burn_high'))
  );

  writeJson(continuumPath, makeContinuumLatest({
    drift: 0.09,
    holdRate: 0.2,
    trit: 1,
    failed: 0,
    blocked: 0
  }));
  writeJson(path.join(budgetDir, `${dateStr}.json`), {
    schema_id: 'system_budget_state',
    schema_version: '1.0.0',
    date: dateStr,
    token_cap: 1000,
    used_est: 300,
    by_module: {},
    updated_at: '2026-02-25T12:10:00.000Z'
  });
  const stabilityDenied = runNode(scriptPath, [
    'route',
    '--context=orchestron.creative_llm',
    '--task-class=workflow_generation',
    '--desired-lane=right',
    '--persist=0',
    `--date=${dateStr}`
  ], env, repoRoot);
  assert.strictEqual(stabilityDenied.status, 0, stabilityDenied.stderr || 'stability denied route should pass');
  const stabilityOut = parseStdoutJson(stabilityDenied);
  assert.strictEqual(stabilityOut.mode, 'left_only');
  assert.ok(Array.isArray(stabilityOut.reasons) && stabilityOut.reasons.includes('stability_drift_high'));

  const statusProc = runNode(scriptPath, [
    'status',
    `--date=${dateStr}`
  ], env, repoRoot);
  assert.strictEqual(statusProc.status, 0, statusProc.stderr || 'status should pass');
  const statusOut = parseStdoutJson(statusProc);
  assert.strictEqual(statusOut.ok, true);
  assert.ok(statusOut.signals && statusOut.signals.resource, 'status should expose signal snapshot');

  console.log('dual_brain_coordinator.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`dual_brain_coordinator.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
