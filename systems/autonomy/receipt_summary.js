#!/usr/bin/env node
'use strict';

/**
 * receipt_summary.js
 *
 * Deterministic autonomy receipt/run scorecard.
 *
 * Usage:
 *   node systems/autonomy/receipt_summary.js run [YYYY-MM-DD] [--days=N]
 *   node systems/autonomy/receipt_summary.js --help
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const AUTONOMY_RUNS_DIR = process.env.AUTONOMY_SUMMARY_RUNS_DIR
  ? path.resolve(process.env.AUTONOMY_SUMMARY_RUNS_DIR)
  : path.join(ROOT, 'state', 'autonomy', 'runs');
const AUTONOMY_RECEIPTS_DIR = process.env.AUTONOMY_SUMMARY_RECEIPTS_DIR
  ? path.resolve(process.env.AUTONOMY_SUMMARY_RECEIPTS_DIR)
  : path.join(ROOT, 'state', 'autonomy', 'receipts');
const ACTUATION_RECEIPTS_DIR = process.env.ACTUATION_SUMMARY_RECEIPTS_DIR
  ? path.resolve(process.env.ACTUATION_SUMMARY_RECEIPTS_DIR)
  : path.join(ROOT, 'state', 'actuation', 'receipts');

function nowIso() {
  return new Date().toISOString();
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/autonomy/receipt_summary.js run [YYYY-MM-DD] [--days=N]');
  console.log('  node systems/autonomy/receipt_summary.js --help');
}

function parseArgs(argv) {
  const out = { _: [] };
  for (const arg of argv) {
    if (!arg.startsWith('--')) {
      out._.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq === -1) out[arg.slice(2)] = true;
    else out[arg.slice(2, eq)] = arg.slice(eq + 1);
  }
  return out;
}

function isDateStr(v) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
}

function clampInt(v, lo, hi, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

function shiftDate(dateStr, deltaDays) {
  const base = new Date(`${dateStr}T00:00:00.000Z`);
  if (Number.isNaN(base.getTime())) return dateStr;
  base.setUTCDate(base.getUTCDate() + Number(deltaDays || 0));
  return base.toISOString().slice(0, 10);
}

function buildWindowDates(endDate, days) {
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    out.push(shiftDate(endDate, -i));
  }
  return out;
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function readJsonlForDates(dirPath, dates) {
  const rows = [];
  const files = [];
  for (const d of dates) {
    const fp = path.join(dirPath, `${d}.jsonl`);
    if (!fs.existsSync(fp)) continue;
    files.push(fp);
    rows.push(...readJsonl(fp));
  }
  return { rows, files };
}

function tallyBy(items, keyFn) {
  const out = {};
  for (const it of items || []) {
    const key = String(keyFn(it) || '').trim();
    if (!key) continue;
    out[key] = Number(out[key] || 0) + 1;
  }
  return out;
}

function sortedTally(obj) {
  const entries = Object.entries(obj || {});
  entries.sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return String(a[0]).localeCompare(String(b[0]));
  });
  return Object.fromEntries(entries);
}

function mergeTallies(...objs) {
  const out = {};
  for (const obj of objs) {
    for (const [k, v] of Object.entries(obj || {})) {
      out[k] = Number(out[k] || 0) + Number(v || 0);
    }
  }
  return sortedTally(out);
}

function summarizeRuns(rows) {
  const runs = (rows || []).filter(r => r && r.type === 'autonomy_run');
  const executed = runs.filter(r => String(r.result || '') === 'executed');
  const previews = runs.filter(r => {
    const res = String(r.result || '');
    return res === 'score_only_preview' || res === 'score_only_evidence';
  });
  const stop = runs.filter(r => String(r.result || '').startsWith('stop_'));
  const initGate = runs.filter(r => {
    const res = String(r.result || '');
    return res.startsWith('stop_init_gate_') || res.startsWith('init_gate_');
  });
  const repeatGate = runs.filter(r => String(r.result || '').startsWith('stop_repeat_gate_'));
  const outcomes = tallyBy(executed, r => String(r.outcome || 'unknown'));
  const results = tallyBy(runs, r => String(r.result || 'unknown'));
  const byStrategy = tallyBy(runs, r => String(r.strategy_id || '').trim());
  const byMode = tallyBy(runs, r => String(r.execution_mode || '').trim());
  const total = runs.length;
  const stopped = stop.length;

  return {
    total,
    executed: executed.length,
    score_only_previews: previews.length,
    stopped,
    stop_ratio: total > 0 ? Number((stopped / total).toFixed(3)) : null,
    run_results: sortedTally(results),
    executed_outcomes: sortedTally(outcomes),
    by_strategy: sortedTally(byStrategy),
    by_execution_mode: sortedTally(byMode),
    stop_reasons: sortedTally(tallyBy(stop, r => String(r.result || 'unknown'))),
    init_gate_reasons: sortedTally(tallyBy(initGate, r => String(r.result || 'unknown'))),
    repeat_gate_reasons: sortedTally(tallyBy(repeatGate, r => String(r.result || 'unknown'))),
    latest_event_ts: runs.length ? String(runs[runs.length - 1].ts || '') : null
  };
}

function autonomyPrimaryFailure(rec) {
  if (!rec || typeof rec !== 'object') return '';
  const v = rec.verification || {};
  if (v && v.primary_failure) return String(v.primary_failure);
  if (Array.isArray(v.failed) && v.failed.length) return String(v.failed[0]);
  if (rec.error && rec.error.code) return String(rec.error.code);
  if (rec.error) return String(rec.error);
  if (rec.verdict && String(rec.verdict).toLowerCase() === 'fail') return 'unknown_failure';
  return '';
}

function isAttemptedReceipt(rec) {
  if (!rec || typeof rec !== 'object') return false;
  const contract = rec.receipt_contract;
  if (!contract || typeof contract !== 'object') return true;
  return contract.attempted !== false;
}

function summarizeAutonomyReceipts(rows) {
  const allReceipts = (rows || []).filter(r => r && r.type === 'autonomy_action_receipt');
  const receipts = allReceipts.filter(isAttemptedReceipt);
  const pass = receipts.filter(r => String(r.verdict || '').toLowerCase() === 'pass').length;
  const fail = receipts.filter(r => String(r.verdict || '').toLowerCase() === 'fail').length;
  const verified = receipts.filter(r => !!(r.receipt_contract && r.receipt_contract.verified === true)).length;
  const failure = tallyBy(receipts.filter(r => String(r.verdict || '').toLowerCase() === 'fail'), autonomyPrimaryFailure);
  let criteriaReceipts = 0;
  let criteriaRequiredReceipts = 0;
  let criteriaReceiptPass = 0;
  let criteriaRowsTotal = 0;
  let criteriaRowsEvaluated = 0;
  let criteriaRowsPassed = 0;
  let criteriaRowsFailed = 0;
  let criteriaRowsUnknown = 0;

  for (const rec of receipts) {
    const verification = rec && rec.verification && typeof rec.verification === 'object'
      ? rec.verification
      : null;
    const criteria = verification && verification.success_criteria && typeof verification.success_criteria === 'object'
      ? verification.success_criteria
      : null;
    if (!criteria) continue;
    criteriaReceipts += 1;
    if (criteria.required === true) criteriaRequiredReceipts += 1;
    if (criteria.passed === true) criteriaReceiptPass += 1;
    criteriaRowsTotal += Number(criteria.total_count || 0);
    criteriaRowsEvaluated += Number(criteria.evaluated_count || 0);
    criteriaRowsPassed += Number(criteria.passed_count || 0);
    criteriaRowsFailed += Number(criteria.failed_count || 0);
    criteriaRowsUnknown += Number(criteria.unknown_count || 0);
  }

  return {
    total: receipts.length,
    skipped_not_attempted: allReceipts.length - receipts.length,
    pass,
    fail,
    verified,
    verified_rate: receipts.length ? Number((verified / receipts.length).toFixed(3)) : null,
    top_failure_reasons: sortedTally(failure),
    success_criteria_receipts: criteriaReceipts,
    success_criteria_required_receipts: criteriaRequiredReceipts,
    success_criteria_receipt_pass: criteriaReceiptPass,
    success_criteria_receipt_pass_rate: criteriaReceipts ? Number((criteriaReceiptPass / criteriaReceipts).toFixed(3)) : null,
    success_criteria_required_pass_rate: criteriaRequiredReceipts
      ? Number((criteriaReceiptPass / criteriaRequiredReceipts).toFixed(3))
      : null,
    success_criteria_rows_total: criteriaRowsTotal,
    success_criteria_rows_evaluated: criteriaRowsEvaluated,
    success_criteria_rows_passed: criteriaRowsPassed,
    success_criteria_rows_failed: criteriaRowsFailed,
    success_criteria_rows_unknown: criteriaRowsUnknown,
    success_criteria_row_pass_rate: criteriaRowsEvaluated
      ? Number((criteriaRowsPassed / criteriaRowsEvaluated).toFixed(3))
      : null
  };
}

function actuationFailureReason(rec) {
  if (!rec || typeof rec !== 'object') return '';
  if (rec.error && rec.error.code) return String(rec.error.code);
  if (rec.error && rec.error.message) return String(rec.error.message);
  if (rec.error) return String(rec.error);
  if (rec.ok === false) return 'unknown_failure';
  return '';
}

function summarizeActuationReceipts(rows) {
  const allReceipts = rows || [];
  const receipts = allReceipts.filter(isAttemptedReceipt);
  const ok = receipts.filter(r => r && r.ok === true).length;
  const failed = receipts.filter(r => r && r.ok !== true).length;
  const verified = receipts.filter(r => !!(r && r.receipt_contract && r.receipt_contract.verified === true)).length;
  const byAdapter = {};
  for (const r of receipts) {
    const adapter = String((r && r.adapter) || 'unknown');
    if (!byAdapter[adapter]) byAdapter[adapter] = { total: 0, ok: 0, verified: 0 };
    byAdapter[adapter].total += 1;
    if (r && r.ok === true) byAdapter[adapter].ok += 1;
    if (r && r.receipt_contract && r.receipt_contract.verified === true) byAdapter[adapter].verified += 1;
  }
  const failures = tallyBy(receipts.filter(r => r && r.ok !== true), actuationFailureReason);
  const byAdapterSorted = Object.fromEntries(
    Object.entries(byAdapter).sort((a, b) => {
      const bt = Number(b[1] && b[1].total || 0);
      const at = Number(a[1] && a[1].total || 0);
      if (bt !== at) return bt - at;
      return String(a[0]).localeCompare(String(b[0]));
    })
  );
  return {
    total: receipts.length,
    skipped_not_attempted: allReceipts.length - receipts.length,
    ok,
    failed,
    verified,
    verified_rate: receipts.length ? Number((verified / receipts.length).toFixed(3)) : null,
    by_adapter: byAdapterSorted,
    top_failure_reasons: sortedTally(failures)
  };
}

function summarizeForDate(dateStr, days) {
  const effectiveDate = isDateStr(dateStr) ? dateStr : todayStr();
  const windowDays = clampInt(days, 1, 30, 7);
  const dates = buildWindowDates(effectiveDate, windowDays);

  const runRows = readJsonlForDates(AUTONOMY_RUNS_DIR, dates);
  const autoReceipts = readJsonlForDates(AUTONOMY_RECEIPTS_DIR, dates);
  const actReceipts = readJsonlForDates(ACTUATION_RECEIPTS_DIR, dates);

  const runs = summarizeRuns(runRows.rows);
  const autonomyReceipts = summarizeAutonomyReceipts(autoReceipts.rows);
  const actuationReceipts = summarizeActuationReceipts(actReceipts.rows);

  const attempted = Number(autonomyReceipts.total || 0) + Number(actuationReceipts.total || 0);
  const verified = Number(autonomyReceipts.verified || 0) + Number(actuationReceipts.verified || 0);

  return {
    ok: true,
    ts: nowIso(),
    window: {
      end_date: effectiveDate,
      start_date: dates[0],
      days: windowDays,
      dates
    },
    files: {
      autonomy_runs: runRows.files.length,
      autonomy_receipts: autoReceipts.files.length,
      actuation_receipts: actReceipts.files.length
    },
    runs,
    receipts: {
      autonomy: autonomyReceipts,
      actuation: actuationReceipts,
      combined: {
        attempted,
        verified,
        verified_rate: attempted ? Number((verified / attempted).toFixed(3)) : null,
        success_criteria_receipt_pass_rate: autonomyReceipts.success_criteria_receipt_pass_rate,
        success_criteria_required_pass_rate: autonomyReceipts.success_criteria_required_pass_rate,
        top_failure_reasons: mergeTallies(
          autonomyReceipts.top_failure_reasons,
          actuationReceipts.top_failure_reasons
        )
      }
    }
  };
}

function cmdRun(args) {
  const dateArg = String(args.date || args._[1] || '').trim();
  const daysArg = String(args.days || '7').trim();
  const out = summarizeForDate(dateArg || todayStr(), daysArg);
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '');
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'run') {
    cmdRun(args);
    return;
  }
  usage();
  process.exit(2);
}

if (require.main === module) {
  main();
}

module.exports = {
  summarizeForDate,
  summarizeRuns,
  summarizeAutonomyReceipts,
  summarizeActuationReceipts
};
