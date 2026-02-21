#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

function mkDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function writeJson(filePath, obj) {
  mkDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), 'utf8');
}

function writeJsonl(filePath, rows) {
  mkDir(path.dirname(filePath));
  const text = (rows || []).map((r) => JSON.stringify(r)).join('\n');
  fs.writeFileSync(filePath, text + (text ? '\n' : ''), 'utf8');
}

function runScript(repoRoot, args, env) {
  const script = path.join(repoRoot, 'systems', 'autonomy', 'pipeline_spc_gate.js');
  return spawnSync('node', [script, ...args], { cwd: repoRoot, encoding: 'utf8', env });
}

function parseJson(stdout) {
  return JSON.parse(String(stdout || '{}'));
}

function buildRows(date) {
  return {
    runs: [
      { ts: `${date}T01:00:00.000Z`, type: 'autonomy_run', result: 'executed', outcome: 'shipped', execution_mode: 'score_only' },
      { ts: `${date}T01:10:00.000Z`, type: 'autonomy_run', result: 'executed', outcome: 'no_change', execution_mode: 'score_only' },
      { ts: `${date}T01:20:00.000Z`, type: 'autonomy_run', result: 'score_only_preview', execution_mode: 'score_only' }
    ],
    receipts: [
      { type: 'autonomy_action_receipt', verdict: 'pass', verification: { success_criteria: { required: true, passed: true } }, receipt_contract: { attempted: true, verified: true } },
      { type: 'autonomy_action_receipt', verdict: 'pass', verification: { success_criteria: { required: true, passed: true } }, receipt_contract: { attempted: true, verified: true } },
      { type: 'autonomy_action_receipt', verdict: 'fail', verification: { success_criteria: { required: true, passed: false } }, receipt_contract: { attempted: true, verified: false } }
    ],
    proposals: [
      {
        id: `P-${date}`,
        title: 'Deterministic remediation',
        meta: { admission_preview: { eligible: true, blocked_by: [] } }
      }
    ]
  };
}

function run() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const tmpRoot = path.join(__dirname, 'temp_pipeline_spc_gate');
  if (fs.existsSync(tmpRoot)) fs.rmSync(tmpRoot, { recursive: true, force: true });

  const runsDir = path.join(tmpRoot, 'state', 'autonomy', 'runs');
  const autoReceiptsDir = path.join(tmpRoot, 'state', 'autonomy', 'receipts');
  const actReceiptsDir = path.join(tmpRoot, 'state', 'actuation', 'receipts');
  const proposalsDir = path.join(tmpRoot, 'state', 'sensory', 'proposals');
  mkDir(runsDir);
  mkDir(autoReceiptsDir);
  mkDir(actReceiptsDir);
  mkDir(proposalsDir);

  const baselineDates = ['2026-02-12', '2026-02-13', '2026-02-14', '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18'];
  for (const d of baselineDates) {
    const rows = buildRows(d);
    writeJsonl(path.join(runsDir, `${d}.jsonl`), rows.runs);
    writeJsonl(path.join(autoReceiptsDir, `${d}.jsonl`), rows.receipts);
    writeJsonl(path.join(actReceiptsDir, `${d}.jsonl`), []);
    writeJson(path.join(proposalsDir, `${d}.json`), rows.proposals);
  }

  const date = '2026-02-19';
  const current = buildRows(date);
  writeJsonl(path.join(runsDir, `${date}.jsonl`), current.runs);
  writeJsonl(path.join(autoReceiptsDir, `${date}.jsonl`), current.receipts);
  writeJsonl(path.join(actReceiptsDir, `${date}.jsonl`), []);
  writeJson(path.join(proposalsDir, `${date}.json`), current.proposals);

  const env = {
    ...process.env,
    AUTONOMY_SUMMARY_RUNS_DIR: runsDir,
    AUTONOMY_SUMMARY_RECEIPTS_DIR: autoReceiptsDir,
    ACTUATION_SUMMARY_RECEIPTS_DIR: actReceiptsDir,
    AUTONOMY_SPC_PROPOSALS_DIR: proposalsDir
  };

  let r = runScript(repoRoot, ['run', date, '--days=1', '--baseline-days=7', '--sigma=3'], env);
  assert.strictEqual(r.status, 0, `expected pass run: ${r.stderr}`);
  let out = parseJson(r.stdout);
  assert.strictEqual(out.pass, true, 'spc gate should pass for healthy data');
  assert.strictEqual(out.hold_escalation, false);

  writeJsonl(path.join(autoReceiptsDir, `${date}.jsonl`), [
    { type: 'autonomy_action_receipt', verdict: 'pass', receipt_contract: { attempted: true, verified: true } },
    { type: 'autonomy_action_receipt', verdict: 'pass', receipt_contract: { attempted: true, verified: true } },
    { type: 'autonomy_action_receipt', verdict: 'fail', receipt_contract: { attempted: true, verified: false } }
  ]);

  r = runScript(repoRoot, ['run', date, '--days=1', '--baseline-days=7', '--sigma=3'], env);
  assert.strictEqual(r.status, 0, `expected second run: ${r.stderr}`);
  out = parseJson(r.stdout);
  assert.strictEqual(out.pass, false, 'spc gate should fail with missing success criteria telemetry');
  assert.ok(Array.isArray(out.failed_checks) && out.failed_checks.includes('success_criteria_receipts'));

  console.log('pipeline_spc_gate.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`pipeline_spc_gate.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
