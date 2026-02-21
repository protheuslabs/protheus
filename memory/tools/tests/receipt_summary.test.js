#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

function mkDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function writeJsonl(filePath, rows) {
  mkDir(path.dirname(filePath));
  const body = (rows || []).map(r => JSON.stringify(r)).join('\n');
  fs.writeFileSync(filePath, body + (rows && rows.length ? '\n' : ''), 'utf8');
}

function run() {
  const tmpRoot = path.join(__dirname, 'temp_receipt_summary');
  if (fs.existsSync(tmpRoot)) fs.rmSync(tmpRoot, { recursive: true, force: true });
  mkDir(tmpRoot);

  const runsDir = path.join(tmpRoot, 'state', 'autonomy', 'runs');
  const autoReceiptsDir = path.join(tmpRoot, 'state', 'autonomy', 'receipts');
  const actReceiptsDir = path.join(tmpRoot, 'state', 'actuation', 'receipts');
  mkDir(runsDir);
  mkDir(autoReceiptsDir);
  mkDir(actReceiptsDir);

  const date = '2026-02-19';
  writeJsonl(path.join(runsDir, `${date}.jsonl`), [
    {
      ts: '2026-02-19T05:00:00.000Z',
      type: 'autonomy_run',
      result: 'executed',
      outcome: 'shipped',
      strategy_id: 's1',
      execution_mode: 'execute',
      objective_id: 'T1_objA',
      directive_pulse: { objective_id: 'T1_objA', score: 80, objective_allocation_score: 70 }
    },
    {
      ts: '2026-02-19T05:05:00.000Z',
      type: 'autonomy_run',
      result: 'executed',
      outcome: 'no_change',
      strategy_id: 's1',
      execution_mode: 'execute',
      objective_id: 'T1_objA',
      directive_pulse: { objective_id: 'T1_objA', score: 60, objective_allocation_score: 50 }
    },
    {
      ts: '2026-02-19T05:07:00.000Z',
      type: 'autonomy_run',
      result: 'score_only_preview',
      strategy_id: 's1',
      execution_mode: 'score_only',
      objective_id: 'T2_objB',
      directive_pulse: { objective_id: 'T2_objB', score: 55, objective_allocation_score: 65 }
    },
    { ts: '2026-02-19T05:10:00.000Z', type: 'autonomy_run', result: 'stop_repeat_gate_no_progress', strategy_id: 's1', execution_mode: 'execute', objective_id: 'T2_objB' },
    { ts: '2026-02-19T05:12:00.000Z', type: 'autonomy_run', result: 'stop_init_gate_quality_exhausted', strategy_id: 's2', execution_mode: 'execute' }
  ]);

  writeJsonl(path.join(autoReceiptsDir, `${date}.jsonl`), [
    {
      ts: '2026-02-19T05:00:01.000Z',
      type: 'autonomy_action_receipt',
      verdict: 'pass',
      intent: { score_only: true, objective_id: 'T1_objA' },
      verification: {
        passed: true,
        failed: [],
        primary_failure: null,
        success_criteria: {
          required: true,
          min_count: 1,
          total_count: 2,
          evaluated_count: 2,
          passed_count: 2,
          failed_count: 0,
          unknown_count: 0,
          pass_rate: 1,
          passed: true
        }
      },
      receipt_contract: { version: '1.0', attempted: true, verified: true, recorded: true }
    },
    {
      ts: '2026-02-19T05:05:01.000Z',
      type: 'autonomy_action_receipt',
      verdict: 'fail',
      intent: { objective_id: 'T1_objA' },
      verification: {
        passed: false,
        failed: ['postconditions_ok'],
        primary_failure: 'postconditions_ok',
        success_criteria: {
          required: true,
          min_count: 1,
          total_count: 2,
          evaluated_count: 2,
          passed_count: 1,
          failed_count: 1,
          unknown_count: 0,
          pass_rate: 0.5,
          passed: false,
          primary_failure: 'success_criteria_failed:requires_shipped_outcome'
        }
      },
      receipt_contract: { version: '1.0', attempted: true, verified: false, recorded: true }
    }
  ]);

  writeJsonl(path.join(actReceiptsDir, `${date}.jsonl`), [
    {
      ts: '2026-02-19T05:00:02.000Z',
      adapter: 'moltbook_publish',
      ok: true,
      receipt_contract: { version: '1.0', attempted: true, verified: true, recorded: true }
    },
    {
      ts: '2026-02-19T05:05:02.000Z',
      adapter: 'moltbook_publish',
      ok: false,
      error: { code: 'HTTP_429' },
      receipt_contract: { version: '1.0', attempted: true, verified: false, recorded: true }
    },
    {
      ts: '2026-02-19T05:06:02.000Z',
      adapter: 'moltbook_publish',
      ok: true,
      dry_run: true,
      receipt_contract: { version: '1.0', attempted: false, verified: false, recorded: true }
    }
  ]);

  process.env.AUTONOMY_SUMMARY_RUNS_DIR = runsDir;
  process.env.AUTONOMY_SUMMARY_RECEIPTS_DIR = autoReceiptsDir;
  process.env.ACTUATION_SUMMARY_RECEIPTS_DIR = actReceiptsDir;

  const script = require('../../../systems/autonomy/receipt_summary.js');
  const out = script.summarizeForDate(date, 1);

  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.runs.total, 5);
  assert.strictEqual(out.runs.executed, 2);
  assert.strictEqual(out.runs.score_only_previews, 1);
  assert.strictEqual(Number(out.runs.executed_outcomes.shipped || 0), 1);
  assert.strictEqual(Number(out.runs.executed_outcomes.no_change || 0), 1);
  assert.strictEqual(Number(out.runs.stop_reasons.stop_repeat_gate_no_progress || 0), 1);
  assert.strictEqual(Number(out.runs.init_gate_reasons.stop_init_gate_quality_exhausted || 0), 1);
  assert.strictEqual(Number(out.runs.by_strategy.s1 || 0), 4);
  assert.strictEqual(Number(out.runs.by_strategy.s2 || 0), 1);
  assert.strictEqual(Number(out.runs.by_execution_mode.execute || 0), 4);
  assert.strictEqual(Number(out.runs.by_execution_mode.score_only || 0), 1);
  assert.strictEqual(Number(out.runs.objective_scorecard.T1_objA.attempts || 0), 2);
  assert.strictEqual(Number(out.runs.objective_scorecard.T1_objA.executed || 0), 2);
  assert.strictEqual(Number(out.runs.objective_scorecard.T1_objA.shipped || 0), 1);
  assert.strictEqual(Number(out.runs.objective_scorecard.T1_objA.no_change || 0), 1);
  assert.strictEqual(out.runs.objective_scorecard.T1_objA.pulse_score_avg, 70);
  assert.strictEqual(out.runs.objective_scorecard.T1_objA.objective_allocation_score_avg, 60);
  assert.strictEqual(Number(out.runs.objective_scorecard.T2_objB.attempts || 0), 2);

  assert.strictEqual(out.receipts.autonomy.total, 2);
  assert.strictEqual(out.receipts.autonomy.skipped_not_attempted, 0);
  assert.strictEqual(out.receipts.autonomy.pass, 1);
  assert.strictEqual(out.receipts.autonomy.fail, 1);
  assert.strictEqual(Number(out.receipts.autonomy.top_failure_reasons.postconditions_ok || 0), 1);
  assert.strictEqual(out.receipts.autonomy.success_criteria_receipts, 2);
  assert.strictEqual(out.receipts.autonomy.success_criteria_required_receipts, 2);
  assert.strictEqual(out.receipts.autonomy.success_criteria_receipt_pass, 1);
  assert.strictEqual(out.receipts.autonomy.success_criteria_receipt_pass_rate, 0.5);
  assert.strictEqual(out.receipts.autonomy.success_criteria_row_pass_rate, 0.75);
  assert.strictEqual(out.receipts.autonomy.preview_receipts, 1);
  assert.strictEqual(out.receipts.autonomy.success_criteria_preview_receipts, 1);
  assert.strictEqual(out.receipts.autonomy.success_criteria_preview_pass, 1);
  assert.strictEqual(out.receipts.autonomy.success_criteria_preview_pass_rate, 1);
  assert.strictEqual(Number(out.receipts.autonomy.by_objective.T1_objA.total || 0), 2);
  assert.strictEqual(out.receipts.autonomy.by_objective.T1_objA.pass_rate, 0.5);
  assert.strictEqual(out.receipts.autonomy.by_objective.T1_objA.success_criteria_pass_rate, 0.5);

  assert.strictEqual(out.receipts.actuation.total, 2);
  assert.strictEqual(out.receipts.actuation.skipped_not_attempted, 1);
  assert.strictEqual(out.receipts.actuation.ok, 1);
  assert.strictEqual(out.receipts.actuation.failed, 1);
  assert.strictEqual(Number(out.receipts.actuation.top_failure_reasons.HTTP_429 || 0), 1);

  assert.strictEqual(out.receipts.combined.attempted, 4);
  assert.strictEqual(out.receipts.combined.verified, 2);
  assert.strictEqual(out.receipts.combined.verified_rate, 0.5);
  assert.strictEqual(out.receipts.combined.success_criteria_receipt_pass_rate, 0.5);
  assert.strictEqual(out.receipts.combined.success_criteria_preview_pass_rate, 1);
  assert.strictEqual(Number(out.receipts.combined.top_failure_reasons.postconditions_ok || 0), 1);
  assert.strictEqual(Number(out.receipts.combined.top_failure_reasons.HTTP_429 || 0), 1);

  console.log('receipt_summary.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`receipt_summary.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
