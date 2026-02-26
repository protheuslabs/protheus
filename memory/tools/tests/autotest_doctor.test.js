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
  const body = (rows || []).map((row) => JSON.stringify(row)).join('\n');
  fs.writeFileSync(filePath, body ? `${body}\n` : '', 'utf8');
}

function parsePayload(stdout) {
  const raw = String(stdout || '').trim();
  assert.ok(raw, 'expected stdout json payload');
  try { return JSON.parse(raw); } catch {}
  const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  throw new Error('unable to parse json payload');
}

function runNode(scriptPath, args, env, cwd) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd,
    env,
    encoding: 'utf8'
  });
}

function run() {
  const root = path.resolve(__dirname, '..', '..', '..');
  const scriptPath = path.join(root, 'systems', 'ops', 'autotest_doctor.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'autotest-doctor-'));
  const dateStr = '2026-02-26';

  const stateDir = path.join(tmp, 'state', 'ops', 'autotest_doctor');
  const researchDir = path.join(tmp, 'research', 'autotest_doctor');
  const autotestRunsDir = path.join(tmp, 'state', 'ops', 'autotest', 'runs');
  const autotestLatestPath = path.join(tmp, 'state', 'ops', 'autotest', 'latest.json');
  const autotestStatusPath = path.join(tmp, 'state', 'ops', 'autotest', 'status.json');
  const autotestRegistryPath = path.join(tmp, 'state', 'ops', 'autotest', 'registry.json');
  const policyPath = path.join(tmp, 'config', 'autotest_doctor_policy.json');
  const strictPolicyPath = path.join(tmp, 'config', 'autotest_doctor_kill_policy.json');
  const rollbackPolicyPath = path.join(tmp, 'config', 'autotest_doctor_rollback_policy.json');
  const rollbackStateDir = path.join(tmp, 'state', 'ops', 'autotest_doctor_rollback');
  const destructiveStateDir = path.join(tmp, 'state', 'ops', 'autotest_doctor_destructive');

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    shadow_mode: true,
    sleep_window_local: { enabled: false, start_hour: 0, end_hour: 7 },
    gating: {
      min_consecutive_failures: 1,
      max_actions_per_run: 3,
      cooldown_sec_per_signature: 0,
      max_repairs_per_signature_per_day: 5
    },
    kill_switch: {
      enabled: true,
      window_hours: 24,
      max_unknown_signatures_per_window: 10,
      max_suspicious_signatures_per_window: 10,
      max_repairs_per_window: 20,
      max_rollbacks_per_window: 5,
      max_same_signature_repairs_per_window: 5,
      auto_reset_hours: 0
    },
    recipes: [
      {
        id: 'retest_then_pulse',
        enabled: true,
        applies_to: ['assertion_failed', 'timeout', 'exit_nonzero', 'flaky'],
        steps: ['retest_failed_test', 'autotest_run_changed']
      },
      {
        id: 'guard_recover',
        enabled: true,
        applies_to: ['guard_blocked'],
        steps: ['autotest_sync', 'autotest_run_changed']
      }
    ]
  });

  writeJson(strictPolicyPath, {
    version: '1.0-test-kill',
    enabled: true,
    shadow_mode: true,
    sleep_window_local: { enabled: false, start_hour: 0, end_hour: 7 },
    gating: {
      min_consecutive_failures: 1,
      max_actions_per_run: 3,
      cooldown_sec_per_signature: 0,
      max_repairs_per_signature_per_day: 5
    },
    kill_switch: {
      enabled: true,
      window_hours: 24,
      max_unknown_signatures_per_window: 10,
      max_suspicious_signatures_per_window: 0,
      max_repairs_per_window: 20,
      max_rollbacks_per_window: 5,
      max_same_signature_repairs_per_window: 5,
      auto_reset_hours: 0
    },
    recipes: [
      {
        id: 'retest_then_pulse',
        enabled: true,
        applies_to: ['assertion_failed', 'timeout', 'exit_nonzero', 'flaky'],
        steps: ['retest_failed_test', 'autotest_run_changed']
      }
    ]
  });

  writeJson(rollbackPolicyPath, {
    version: '1.0-test-rollback',
    enabled: true,
    shadow_mode: false,
    sleep_window_local: { enabled: false, start_hour: 0, end_hour: 7 },
    gating: {
      min_consecutive_failures: 1,
      max_actions_per_run: 2,
      cooldown_sec_per_signature: 0,
      max_repairs_per_signature_per_day: 5
    },
    kill_switch: {
      enabled: true,
      window_hours: 24,
      max_unknown_signatures_per_window: 10,
      max_suspicious_signatures_per_window: 10,
      max_repairs_per_window: 50,
      max_rollbacks_per_window: 50,
      max_same_signature_repairs_per_window: 20,
      auto_reset_hours: 0
    },
    execution: { step_timeout_ms: 2000, autotest_max_tests: 1 },
    recipes: [
      {
        id: 'retest_then_pulse',
        enabled: true,
        applies_to: ['assertion_failed', 'timeout', 'exit_nonzero', 'flaky'],
        steps: ['retest_failed_test']
      }
    ],
    rollback: {
      enabled: true,
      mode: 'none',
      snapshot_files: [
        'state/ops/autotest/latest.json',
        'state/ops/autotest/status.json',
        'state/ops/autotest/registry.json'
      ],
      store_broken_pieces: true,
      max_excerpt_files: 5,
      max_excerpt_chars: 1200
    }
  });

  writeJson(autotestLatestPath, {
    ok: true,
    type: 'autotest_report',
    ts: `${dateStr}T10:00:00.000Z`,
    date: dateStr,
    failed_tests: 1,
    modules_red: 1,
    modules_changed: 1,
    untested_modules: 2
  });
  writeJson(autotestStatusPath, { modules: {} });
  writeJson(autotestRegistryPath, { modules: {} });

  writeJsonl(path.join(autotestRunsDir, `${dateStr}.jsonl`), [
    {
      ok: true,
      type: 'autotest_run',
      ts: `${dateStr}T10:01:00.000Z`,
      selected_tests: 1,
      failed: 1,
      guard_blocked: 0,
      results: [
        {
          id: 'tst_fail_1',
          command: 'node memory/tools/tests/autotest_doctor.test.js',
          guard_ok: true,
          ok: false,
          exit_code: 1,
          stderr_excerpt: 'simulated assertion failure',
          stdout_excerpt: '',
          guard_files: ['systems/ops/autotest_doctor.ts']
        }
      ]
    }
  ]);

  const env = {
    ...process.env,
    AUTOTEST_DOCTOR_STATE_DIR: stateDir,
    AUTOTEST_DOCTOR_RESEARCH_DIR: researchDir,
    AUTOTEST_DOCTOR_TRIT_SHADOW_HISTORY_PATH: path.join(tmp, 'state', 'autonomy', 'trit_shadow_reports', 'history.jsonl'),
    AUTOTEST_DOCTOR_AUTOTEST_RUNS_DIR: autotestRunsDir,
    AUTOTEST_DOCTOR_AUTOTEST_LATEST_PATH: autotestLatestPath,
    AUTOTEST_DOCTOR_AUTOTEST_STATUS_PATH: autotestStatusPath,
    AUTOTEST_DOCTOR_AUTOTEST_REGISTRY_PATH: autotestRegistryPath,
    SYSTEM_HEALTH_EVENTS_PATH: path.join(tmp, 'state', 'ops', 'system_health', 'events.jsonl')
  };

  const runProc = runNode(scriptPath, ['run', dateStr, `--policy=${policyPath}`, '--apply=0'], env, root);
  assert.strictEqual(runProc.status, 0, runProc.stderr || 'run should pass');
  const runOut = parsePayload(runProc.stdout);
  assert.strictEqual(runOut.ok, true);
  assert.strictEqual(Number(runOut.failures_observed || 0), 1, 'should observe one failure');
  assert.strictEqual(Number(runOut.actions_planned || 0), 1, 'should plan one action in shadow mode');
  assert.strictEqual(Number(runOut.actions_applied || 0), 0, 'shadow mode should not apply repairs');
  assert.strictEqual(Number(runOut.rollbacks || 0), 0, 'shadow mode should not rollback');

  const statusProc = runNode(scriptPath, ['status', 'latest', `--policy=${policyPath}`], env, root);
  assert.strictEqual(statusProc.status, 0, statusProc.stderr || 'status should pass');
  const statusOut = parsePayload(statusProc.stdout);
  assert.strictEqual(statusOut.ok, true);
  assert.strictEqual(statusOut.kill_switch.engaged, false, 'kill switch should stay disengaged');

  // Suspicious signature should trip kill-switch under strict threshold.
  writeJsonl(path.join(autotestRunsDir, `${dateStr}.jsonl`), [
    {
      ok: true,
      type: 'autotest_run',
      ts: `${dateStr}T10:05:00.000Z`,
      selected_tests: 1,
      failed: 1,
      guard_blocked: 0,
      results: [
        {
          id: 'tst_fail_2',
          command: 'node memory/tools/tests/autotest_doctor.test.js; echo hacked',
          guard_ok: true,
          ok: false,
          exit_code: 1,
          stderr_excerpt: 'simulated suspicious failure',
          stdout_excerpt: '',
          guard_files: ['systems/ops/autotest_doctor.ts']
        }
      ]
    }
  ]);

  const killProc = runNode(scriptPath, ['run', dateStr, `--policy=${strictPolicyPath}`, '--apply=0'], env, root);
  assert.strictEqual(killProc.status, 0, killProc.stderr || 'kill run should pass');
  const killOut = parsePayload(killProc.stdout);
  assert.strictEqual(killOut.ok, true);
  assert.strictEqual(!!(killOut.kill_switch && killOut.kill_switch.engaged === true), true, 'kill switch should engage on suspicious signature threshold');

  const resetProc = runNode(scriptPath, ['run', dateStr, `--policy=${strictPolicyPath}`, '--apply=0', '--reset-kill-switch=1', '--force=1'], env, root);
  assert.strictEqual(resetProc.status, 0, resetProc.stderr || 'reset run should pass');
  const resetOut = parsePayload(resetProc.stdout);
  assert.strictEqual(resetOut.ok, true);
  assert.strictEqual(!!(resetOut.kill_switch && resetOut.kill_switch.engaged === true), true, 'strict policy should re-engage kill switch after reset due same suspicious input');

  // Rollback + forensic bundle path: trusted but missing test file should fail repair and archive broken piece.
  writeJsonl(path.join(autotestRunsDir, `${dateStr}.jsonl`), [
    {
      ok: true,
      type: 'autotest_run',
      ts: `${dateStr}T10:10:00.000Z`,
      selected_tests: 1,
      failed: 1,
      guard_blocked: 0,
      results: [
        {
          id: 'tst_missing_fixture',
          command: 'node memory/tools/tests/__doctor_missing_fixture__.test.js',
          guard_ok: true,
          ok: false,
          exit_code: 1,
          stderr_excerpt: 'missing fixture',
          stdout_excerpt: '',
          guard_files: ['systems/ops/autotest_doctor.ts']
        }
      ]
    }
  ]);

  const rollbackEnv = {
    ...env,
    AUTOTEST_DOCTOR_STATE_DIR: rollbackStateDir
  };
  const rollbackProc = runNode(scriptPath, ['run', dateStr, `--policy=${rollbackPolicyPath}`, '--apply=1'], rollbackEnv, root);
  assert.strictEqual(rollbackProc.status, 0, rollbackProc.stderr || 'rollback run should pass');
  const rollbackOut = parsePayload(rollbackProc.stdout);
  assert.strictEqual(rollbackOut.ok, true);
  assert.strictEqual(Number(rollbackOut.actions_applied || 0), 1, 'rollback run should apply one repair attempt');
  assert.strictEqual(Number(rollbackOut.rollbacks || 0), 1, 'missing fixture should trigger rollback');
  assert.strictEqual(Number(rollbackOut.broken_pieces_stored || 0), 1, 'rollback should persist a broken piece bundle');
  assert.strictEqual(Number(rollbackOut.research_items_stored || 0), 1, 'rollback should mirror broken piece into research area');
  assert.strictEqual(Number(rollbackOut.first_principles_generated || 0), 1, 'rollback should generate one first principle');
  assert.ok(Array.isArray(rollbackOut.broken_piece_paths) && rollbackOut.broken_piece_paths.length >= 1, 'broken piece path should be reported');
  assert.ok(Array.isArray(rollbackOut.research_item_paths) && rollbackOut.research_item_paths.length >= 1, 'research item path should be reported');
  assert.ok(Array.isArray(rollbackOut.first_principle_ids) && rollbackOut.first_principle_ids.length >= 1, 'first principle id should be reported');
  const brokenAbs = path.resolve(root, String(rollbackOut.broken_piece_paths[0]));
  const researchAbs = path.resolve(root, String(rollbackOut.research_item_paths[0]));
  assert.ok(fs.existsSync(brokenAbs), 'broken piece bundle should exist on disk');
  assert.ok(fs.existsSync(researchAbs), 'research mirror bundle should exist on disk');
  const researchPayload = JSON.parse(fs.readFileSync(researchAbs, 'utf8'));
  assert.ok(researchPayload && researchPayload.quarantine && typeof researchPayload.quarantine === 'object', 'research payload should include quarantine plan');
  assert.ok(Number(researchPayload.quarantine.duration_days || 0) >= 1, 'quarantine duration should be >= 1 day');
  const tritBeliefLatest = path.join(rollbackStateDir, 'trit_beliefs', 'latest.json');
  assert.ok(fs.existsSync(tritBeliefLatest), 'doctor trit belief latest should exist');

  // Destructive signatures require explicit approval before reimplementation.
  writeJsonl(path.join(autotestRunsDir, `${dateStr}.jsonl`), [
    {
      ok: true,
      type: 'autotest_run',
      ts: `${dateStr}T10:20:00.000Z`,
      selected_tests: 1,
      failed: 1,
      guard_blocked: 0,
      results: [
        {
          id: 'tst_destructive_guard',
          command: 'node memory/tools/tests/autotest_doctor.test.js',
          guard_ok: true,
          ok: false,
          exit_code: 1,
          stderr_excerpt: 'detected disable_guard path',
          stdout_excerpt: '',
          guard_files: ['systems/ops/autotest_doctor.ts']
        }
      ]
    }
  ]);
  const destructiveEnv = {
    ...env,
    AUTOTEST_DOCTOR_STATE_DIR: destructiveStateDir
  };
  const destructiveProc = runNode(scriptPath, ['run', dateStr, `--policy=${rollbackPolicyPath}`, '--apply=1'], destructiveEnv, root);
  assert.strictEqual(destructiveProc.status, 0, destructiveProc.stderr || 'destructive run should pass');
  const destructiveOut = parsePayload(destructiveProc.stdout);
  assert.strictEqual(destructiveOut.ok, true);
  assert.strictEqual(Number(destructiveOut.destructive_repair_blocks || 0), 1, 'destructive signature should be blocked without approval');
  assert.strictEqual(Number(destructiveOut.actions_applied || 0), 0, 'destructive signature should not apply repair without approval');
  assert.ok(Array.isArray(destructiveOut.actions) && destructiveOut.actions.some((row) => row && row.reason === 'destructive_signature_requires_human_approval'), 'destructive approval block reason should be present');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('autotest_doctor.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autotest_doctor.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
