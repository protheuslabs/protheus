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
  const body = (rows || []).map((r) => JSON.stringify(r)).join('\n');
  fs.writeFileSync(filePath, body + (body ? '\n' : ''), 'utf8');
}

function run() {
  const tmpRoot = path.join(__dirname, 'temp_receipt_summary_criteria_fallback');
  if (fs.existsSync(tmpRoot)) fs.rmSync(tmpRoot, { recursive: true, force: true });
  mkDir(tmpRoot);

  const runsDir = path.join(tmpRoot, 'state', 'autonomy', 'runs');
  const autoReceiptsDir = path.join(tmpRoot, 'state', 'autonomy', 'receipts');
  const actReceiptsDir = path.join(tmpRoot, 'state', 'actuation', 'receipts');
  mkDir(runsDir);
  mkDir(autoReceiptsDir);
  mkDir(actReceiptsDir);

  const date = '2026-02-21';
  writeJsonl(path.join(runsDir, `${date}.jsonl`), []);
  writeJsonl(path.join(autoReceiptsDir, `${date}.jsonl`), [
    {
      ts: '2026-02-21T06:01:00.000Z',
      type: 'autonomy_action_receipt',
      verdict: 'fail',
      intent: { objective_id: 'T1_default' },
      verification: {
        passed: false,
        checks: [{ name: 'preview_executable', pass: false }],
        failed: ['preview_executable'],
        primary_failure: 'preflight_not_executable',
        criteria_quality_insufficient: true
      },
      receipt_contract: { version: '1.0', attempted: true, verified: false, recorded: true }
    },
    {
      ts: '2026-02-21T06:02:00.000Z',
      type: 'autonomy_action_receipt',
      verdict: 'pass',
      intent: {
        objective_id: 'T1_default',
        score_only: true,
        success_criteria_policy: { required: false, min_count: 0 }
      },
      verification: {
        passed: true,
        checks: [{ name: 'preview_executable', pass: true }],
        failed: [],
        primary_failure: null
      },
      receipt_contract: { version: '1.0', attempted: true, verified: true, recorded: true }
    }
  ]);
  writeJsonl(path.join(actReceiptsDir, `${date}.jsonl`), []);

  process.env.AUTONOMY_SUMMARY_RUNS_DIR = runsDir;
  process.env.AUTONOMY_SUMMARY_RECEIPTS_DIR = autoReceiptsDir;
  process.env.ACTUATION_SUMMARY_RECEIPTS_DIR = actReceiptsDir;

  const script = require('../../../systems/autonomy/receipt_summary.js');
  const out = script.summarizeForDate(date, 1);

  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.receipts.autonomy.total, 2);
  assert.strictEqual(out.receipts.autonomy.success_criteria_receipts, 2);
  assert.strictEqual(out.receipts.autonomy.success_criteria_required_receipts, 1);
  assert.strictEqual(out.receipts.autonomy.success_criteria_receipt_pass, 1);
  assert.strictEqual(out.receipts.autonomy.success_criteria_receipt_pass_rate, 0.5);
  assert.strictEqual(out.receipts.autonomy.success_criteria_preview_receipts, 1);
  assert.strictEqual(out.receipts.autonomy.success_criteria_preview_pass, 1);
  assert.strictEqual(out.receipts.autonomy.success_criteria_preview_pass_rate, 1);
  assert.strictEqual(out.receipts.autonomy.success_criteria_synthesized_receipts, 2);
  assert.strictEqual(out.receipts.autonomy.success_criteria_quality_receipts, 0);
  assert.strictEqual(out.receipts.autonomy.success_criteria_quality_receipt_pass_rate, null);
  assert.strictEqual(out.receipts.autonomy.success_criteria_quality_filtered_receipts, 2);
  assert.strictEqual(out.receipts.autonomy.success_criteria_quality_insufficient_receipts, 1);
  assert.strictEqual(Number(out.receipts.autonomy.success_criteria_quality_filter_reasons.synthesized_criteria || 0), 2);
  assert.strictEqual(Number(out.receipts.autonomy.success_criteria_quality_filter_reasons.high_unknown_rate || 0), 2);
  assert.strictEqual(Number(out.receipts.autonomy.success_criteria_quality_filter_reasons.criteria_quality_insufficient_flag || 0), 1);

  console.log('receipt_summary_success_criteria_fallback.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`receipt_summary_success_criteria_fallback.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
