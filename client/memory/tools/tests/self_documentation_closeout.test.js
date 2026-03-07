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
  const body = Array.isArray(rows) ? rows.map((r) => JSON.stringify(r)).join('\n') : '';
  fs.writeFileSync(filePath, body ? `${body}\n` : '', 'utf8');
}

function runCmd(scriptPath, dateStr, env, extraArgs = []) {
  const proc = spawnSync(process.execPath, [scriptPath, 'run', dateStr, ...extraArgs], {
    cwd: env.AUTONOMY_SELF_DOC_ROOT,
    encoding: 'utf8',
    env
  });
  assert.strictEqual(proc.status, 0, proc.stderr || 'self documentation run should succeed');
  return JSON.parse(String(proc.stdout || '{}').trim());
}

function run() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const scriptPath = path.join(repoRoot, 'systems', 'autonomy', 'self_documentation_closeout.js');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'self-doc-closeout-'));

  const memoryPath = path.join(tmpRoot, 'MEMORY.md');
  fs.writeFileSync(memoryPath, '# MEMORY.md\n\n## Session Summaries\n', 'utf8');

  const dailyLogsDir = path.join(tmpRoot, 'state', 'daily_logs');
  const autonomyRunsDir = path.join(tmpRoot, 'state', 'autonomy', 'runs');
  const suggestionLaneDir = path.join(tmpRoot, 'state', 'autonomy', 'suggestion_lane');
  const simulationDir = path.join(tmpRoot, 'state', 'autonomy', 'simulations');
  const integrityLogPath = path.join(tmpRoot, 'state', 'security', 'integrity_violations.jsonl');
  const outputDir = path.join(tmpRoot, 'state', 'autonomy', 'self_documentation');

  const env = {
    ...process.env,
    AUTONOMY_SELF_DOC_ROOT: tmpRoot,
    AUTONOMY_SELF_DOC_MEMORY_PATH: memoryPath,
    AUTONOMY_SELF_DOC_OUTPUT_DIR: outputDir,
    AUTONOMY_SELF_DOC_DAILY_LOGS_DIR: dailyLogsDir,
    AUTONOMY_SELF_DOC_AUTONOMY_RUNS_DIR: autonomyRunsDir,
    AUTONOMY_SELF_DOC_SUGGESTION_LANE_DIR: suggestionLaneDir,
    AUTONOMY_SELF_DOC_SIMULATION_DIR: simulationDir,
    AUTONOMY_SELF_DOC_INTEGRITY_LOG_PATH: integrityLogPath
  };

  // Case 1: non-significant run should auto-apply into MEMORY.md.
  const date1 = '2026-02-25';
  writeJson(path.join(dailyLogsDir, `${date1}.json`), {
    entries: [{ tag: 'automation', minutes: 30 }],
    artifacts: ['receipt-1'],
    revenue_actions: [{ status: 'verified' }]
  });
  writeJsonl(path.join(autonomyRunsDir, `${date1}.jsonl`), [
    { ts: `${date1}T01:00:00.000Z`, type: 'autonomy_run', result: 'executed', outcome: 'shipped' },
    { ts: `${date1}T01:05:00.000Z`, type: 'autonomy_candidate_audit' }
  ]);
  writeJson(path.join(suggestionLaneDir, `${date1}.json`), {
    merged_count: 3,
    total_candidates: 4,
    capped: false
  });
  writeJson(path.join(simulationDir, `${date1}.json`), {
    effective_drift_rate: 0.026,
    yield_rate: 0.714
  });

  const out1 = runCmd(scriptPath, date1, env);
  assert.strictEqual(out1.ok, true);
  assert.strictEqual(out1.applied, true);
  assert.strictEqual(out1.requires_review, false);
  const memoryAfter1 = fs.readFileSync(memoryPath, 'utf8');
  assert.ok(memoryAfter1.includes(`- ${date1}:`), 'date1 summary should be present in MEMORY.md');

  // Case 2: significant run (integrity violation) should require review and not apply by default.
  const date2 = '2026-02-26';
  writeJson(path.join(dailyLogsDir, `${date2}.json`), {
    entries: [{ tag: 'automation', minutes: 10 }],
    artifacts: [],
    revenue_actions: []
  });
  writeJsonl(path.join(autonomyRunsDir, `${date2}.jsonl`), [
    { ts: `${date2}T01:00:00.000Z`, type: 'autonomy_candidate_audit' }
  ]);
  writeJson(path.join(simulationDir, `${date2}.json`), {
    drift_rate: 0.024,
    yield_rate: 0.709
  });
  writeJsonl(integrityLogPath, [
    { ts: `${date2}T02:11:00.000Z`, violated_files: ['client/systems/security/merge_guard.js'] }
  ]);

  const out2 = runCmd(scriptPath, date2, env);
  assert.strictEqual(out2.ok, true);
  assert.strictEqual(out2.requires_review, true);
  assert.strictEqual(out2.applied, false);
  const memoryAfter2 = fs.readFileSync(memoryPath, 'utf8');
  assert.ok(!memoryAfter2.includes(`- ${date2}:`), 'date2 should not be applied without approval');

  // Case 3: approved significant run should apply.
  const out3 = runCmd(scriptPath, date2, env, ['--approve=1']);
  assert.strictEqual(out3.ok, true);
  assert.strictEqual(out3.requires_review, false);
  assert.strictEqual(out3.applied, true);
  const memoryAfter3 = fs.readFileSync(memoryPath, 'utf8');
  assert.ok(memoryAfter3.includes(`- ${date2}:`), 'date2 should be applied with approval');

  // Status command smoke.
  const statusProc = spawnSync(process.execPath, [scriptPath, 'status', date2], {
    cwd: tmpRoot,
    encoding: 'utf8',
    env
  });
  assert.strictEqual(statusProc.status, 0, statusProc.stderr || 'status command should succeed');
  const statusOut = JSON.parse(String(statusProc.stdout || '{}').trim());
  assert.strictEqual(statusOut.ok, true);
  assert.strictEqual(statusOut.date, date2);

  console.log('self_documentation_closeout.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`self_documentation_closeout.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
