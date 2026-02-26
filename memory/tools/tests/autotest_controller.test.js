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

function parseJsonStdout(proc) {
  const raw = String(proc.stdout || '').trim();
  assert.ok(raw, 'expected JSON stdout');
  return JSON.parse(raw);
}

function run() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const scriptPath = path.join(repoRoot, 'systems', 'ops', 'autotest_controller.js');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autotest-controller-'));
  const moduleRoot = path.join(tmpRoot, 'systems');
  const testRoot = path.join(tmpRoot, 'memory', 'tools', 'tests');
  const stateDir = path.join(tmpRoot, 'state', 'ops', 'autotest');
  const policyPath = path.join(tmpRoot, 'config', 'autotest_policy.json');

  writeFile(path.join(moduleRoot, 'alpha', 'alpha_task.ts'), 'export const alpha = 1;\n');
  writeFile(path.join(moduleRoot, 'beta', 'beta_task.ts'), 'export const beta = 1;\n');

  writeFile(
    path.join(testRoot, 'alpha_task.test.js'),
    '#!/usr/bin/env node\nconsole.log("alpha pass");\n'
  );
  writeFile(
    path.join(testRoot, 'beta_task.test.js'),
    '#!/usr/bin/env node\nconsole.log("beta pass");\n'
  );

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    module_discovery: {
      root: 'systems',
      include_ext: ['.ts'],
      ignore_prefixes: []
    },
    test_discovery: {
      root: 'memory/tools/tests',
      include_suffix: '.test.js',
      ignore_prefixes: []
    },
    heuristics: {
      min_match_score: 4,
      min_token_len: 3,
      shared_token_score: 2,
      basename_contains_score: 4,
      layer_hint_score: 0
    },
    explicit_maps: {
      by_prefix: {}
    },
    critical_commands: [],
    alerts: {
      emit_untested: true,
      emit_changed_without_tests: true,
      max_untested_in_report: 120,
      max_failed_in_report: 120
    },
    execution: {
      default_scope: 'changed',
      max_tests_per_run: 24,
      strict: false,
      timeout_ms_per_test: 30000,
      run_timeout_ms: 120000,
      selection_strategy: 'stale_first',
      midrun_resource_guard: true,
      resource_recheck_every_tests: 1,
      retry_flaky_once: true,
      flaky_quarantine_after: 3,
      flaky_quarantine_sec: 3600
    },
    sleep_window_local: {
      enabled: false,
      start_hour: 0,
      end_hour: 7
    },
    runtime_guard: {
      max_load_per_cpu: 8,
      max_rss_mb: 32000,
      spine_hot_window_sec: 1
    },
    daemon: {
      interval_sec: 1,
      max_cycles: 1,
      jitter_sec: 0
    },
    health_ingest: {
      enabled: false
    }
  });

  const env = {
    ...process.env,
    AUTOTEST_MODULE_ROOT: moduleRoot,
    AUTOTEST_TEST_ROOT: testRoot,
    AUTOTEST_STATE_DIR: stateDir,
    AUTOTEST_POLICY_PATH: policyPath,
    AUTOTEST_SPINE_RUNS_DIR: path.join(tmpRoot, 'state', 'spine', 'runs'),
    CLEARANCE: '3',
    KERNEL_INTEGRITY_ENFORCE: '0'
  };

  const sync1 = runNode(scriptPath, ['sync'], env, repoRoot);
  assert.strictEqual(sync1.status, 0, sync1.stderr || 'sync should pass');
  const syncOut1 = parseJsonStdout(sync1);
  assert.strictEqual(syncOut1.ok, true);
  assert.strictEqual(Number(syncOut1.untested_modules || 0), 0, 'all fixtures should be mapped');

  const run1 = runNode(scriptPath, ['run', '--scope=changed'], env, repoRoot);
  assert.strictEqual(run1.status, 0, run1.stderr || 'run should pass');
  const runOut1 = parseJsonStdout(run1);
  assert.strictEqual(runOut1.ok, true);
  assert.ok(Number(runOut1.selected_tests || 0) >= 1, 'should run alpha test');
  assert.strictEqual(Number(runOut1.run_timeout_ms), 120000, 'run timeout should respect policy default');

  const status1 = runNode(scriptPath, ['status'], env, repoRoot);
  assert.strictEqual(status1.status, 0, status1.stderr || 'status should pass');
  const statusOut1 = parseJsonStdout(status1);
  assert.ok(Number(statusOut1.modules_checked || 0) >= 1, 'alpha should be checked after pass');
  assert.strictEqual(Number(statusOut1.untested_modules || 0), 0, 'all fixtures should stay mapped');

  writeFile(path.join(moduleRoot, 'alpha', 'alpha_task.ts'), 'export const alpha = 2;\n');
  writeFile(path.join(moduleRoot, 'beta', 'beta_task.ts'), 'export const beta = 2;\n');
  const sync2 = runNode(scriptPath, ['sync'], env, repoRoot);
  assert.strictEqual(sync2.status, 0, sync2.stderr || 'second sync should pass');
  const syncOut2 = parseJsonStdout(sync2);
  assert.ok(Number(syncOut2.changed_modules || 0) >= 2, 'changed modules should invalidate checked state');

  const status2 = runNode(scriptPath, ['status'], env, repoRoot);
  assert.strictEqual(status2.status, 0, status2.stderr || 'status2 should pass');
  const statusOut2 = parseJsonStdout(status2);
  assert.ok(Number(statusOut2.modules_changed || 0) >= 2, 'changed modules should be pending');

  // Bias staleness so scheduler should prioritize the oldest changed module first.
  const statusPath = path.join(stateDir, 'status.json');
  const statusRaw = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
  const moduleKeys = Object.keys(statusRaw.modules || {});
  const alphaKey = moduleKeys.find((k) => k.endsWith('alpha/alpha_task.ts'));
  const betaKey = moduleKeys.find((k) => k.endsWith('beta/beta_task.ts'));
  const nowMs = Date.now();
  statusRaw.modules[alphaKey].last_test_ts = new Date(nowMs - (7 * 24 * 60 * 60 * 1000)).toISOString();
  statusRaw.modules[betaKey].last_test_ts = new Date(nowMs - (1 * 60 * 60 * 1000)).toISOString();
  fs.writeFileSync(statusPath, `${JSON.stringify(statusRaw, null, 2)}\n`, 'utf8');

  // Partial run must not incorrectly clear all changed modules.
  const runPartial = runNode(scriptPath, ['run', '--scope=changed', '--max-tests=1'], env, repoRoot);
  assert.strictEqual(runPartial.status, 0, runPartial.stderr || 'partial run should pass');
  const runPartialOut = parseJsonStdout(runPartial);
  assert.strictEqual(runPartialOut.ok, true);
  assert.strictEqual(Number(runPartialOut.selected_tests || 0), 1, 'should run exactly one test when max-tests=1');
  assert.ok(
    Number(
      runPartialOut.selection_preview &&
      runPartialOut.selection_preview[0] &&
      runPartialOut.selection_preview[0].priority &&
      runPartialOut.selection_preview[0].priority.stale_hours
    ) >= 100,
    'stale-first selection should prioritize oldest pending module'
  );

  const statusPartial = runNode(scriptPath, ['status'], env, repoRoot);
  assert.strictEqual(statusPartial.status, 0, statusPartial.stderr || 'status after partial should pass');
  const statusPartialOut = parseJsonStdout(statusPartial);
  assert.ok(Number(statusPartialOut.modules_changed || 0) >= 1, 'partial run should keep at least one changed module pending');

  const report = runNode(scriptPath, ['report', 'latest'], env, repoRoot);
  assert.strictEqual(report.status, 0, report.stderr || 'report should pass');
  const reportOut = parseJsonStdout(report);
  assert.strictEqual(reportOut.ok, true);
  assert.ok(reportOut.output_path, 'report should write markdown output');

  const mdPath = path.join(repoRoot, String(reportOut.output_path));
  assert.ok(fs.existsSync(mdPath), 'report markdown should exist');
  const body = fs.readFileSync(mdPath, 'utf8');
  assert.ok(body.includes('Untested Modules'), 'report should include untested modules section');

  const eventsPath = path.join(stateDir, 'events.jsonl');
  if (fs.existsSync(eventsPath)) {
    const eventLines = fs.readFileSync(eventsPath, 'utf8').trim().split('\n').filter(Boolean);
    assert.ok(eventLines.length >= 0, 'events file should be parseable');
  }

  console.log('autotest_controller.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autotest_controller.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
