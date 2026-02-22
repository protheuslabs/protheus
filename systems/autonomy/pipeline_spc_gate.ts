#!/usr/bin/env node
'use strict';

/**
 * pipeline_spc_gate.js
 *
 * Deterministic SPC guard for autonomy pipeline quality.
 * Blocks escalation when process quality drifts beyond control limits.
 *
 * Usage:
 *   node systems/autonomy/pipeline_spc_gate.js run [YYYY-MM-DD] [--days=N] [--baseline-days=N] [--sigma=N]
 *   node systems/autonomy/pipeline_spc_gate.js --help
 */

const fs = require('fs');
const path = require('path');
const { summarizeForDate } = require('./receipt_summary.js');

const ROOT = path.resolve(__dirname, '..', '..');
const PROPOSALS_DIR = process.env.AUTONOMY_SPC_PROPOSALS_DIR
  ? path.resolve(process.env.AUTONOMY_SPC_PROPOSALS_DIR)
  : path.join(ROOT, 'state', 'sensory', 'proposals');

const SPC_MIN_ATTEMPTED = Number(process.env.AUTONOMY_SPC_MIN_ATTEMPTED || 3);
const SPC_MIN_ADMISSION_EVIDENCE = Number(process.env.AUTONOMY_SPC_MIN_ADMISSION_EVIDENCE || 1);
const SPC_MAX_STOP_RATIO = Number(process.env.AUTONOMY_SPC_MAX_STOP_RATIO || 0.75);
const SPC_MAX_REVERTED_RATE = Number(process.env.AUTONOMY_SPC_MAX_REVERTED_RATE || 0.35);
const SPC_MIN_SUCCESS_CRITERIA_RECEIPTS = Number(process.env.AUTONOMY_SPC_MIN_SUCCESS_CRITERIA_RECEIPTS || 2);
const SPC_MIN_SUCCESS_CRITERIA_PASS_RATE = Number(process.env.AUTONOMY_SPC_MIN_SUCCESS_CRITERIA_PASS_RATE || 0.6);
const SPC_BASELINE_DAYS = Number(process.env.AUTONOMY_SPC_BASELINE_DAYS || 21);
const SPC_BASELINE_MIN_DAYS = Number(process.env.AUTONOMY_SPC_BASELINE_MIN_DAYS || 7);
const SPC_SIGMA = Number(process.env.AUTONOMY_SPC_SIGMA || 3);

function usage() {
  console.log('Usage:');
  console.log('  node systems/autonomy/pipeline_spc_gate.js run [YYYY-MM-DD] [--days=N] [--baseline-days=N] [--sigma=N]');
  console.log('  node systems/autonomy/pipeline_spc_gate.js --help');
}

function parseArgs(argv) {
  const out = { _: [] } as Record<string, any>;
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

function todayStr() {
  return new Date().toISOString().slice(0, 10);
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
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return dateStr;
  d.setUTCDate(d.getUTCDate() + Number(deltaDays || 0));
  return d.toISOString().slice(0, 10);
}

function buildDates(endDate, days) {
  const out = [];
  for (let i = days - 1; i >= 0; i--) out.push(shiftDate(endDate, -i));
  return out;
}

function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function loadProposalArray(dateStr) {
  const filePath = path.join(PROPOSALS_DIR, `${dateStr}.json`);
  if (!fs.existsSync(filePath)) return [];
  const raw = readJsonSafe(filePath, []);
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object' && Array.isArray(raw.proposals)) return raw.proposals;
  return [];
}

function countEligibleAdmissions(dateStr) {
  const rows = loadProposalArray(dateStr);
  let eligible = 0;
  for (const row of rows) {
    const meta = row && row.meta && typeof row.meta === 'object' ? row.meta : {};
    const admission = meta.admission_preview && typeof meta.admission_preview === 'object'
      ? meta.admission_preview
      : null;
    if (admission && admission.eligible === true) eligible += 1;
  }
  return {
    proposals_scanned: rows.length,
    eligible_admissions: eligible
  };
}

function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function metricForDate(dateStr, days) {
  const summary = summarizeForDate(dateStr, days);
  const attempted = Number(summary && summary.receipts && summary.receipts.combined && summary.receipts.combined.attempted || 0);
  const executed = Number(summary && summary.runs && summary.runs.executed || 0);
  const reverted = Number(summary && summary.runs && summary.runs.executed_outcomes && summary.runs.executed_outcomes.reverted || 0);
  const stopRatio = numOrNull(summary && summary.runs && summary.runs.stop_ratio);
  const revertedRate = executed > 0
    ? Number((reverted / executed).toFixed(3))
    : 0;
  const criteriaReceipts = Number(summary && summary.receipts && summary.receipts.autonomy && summary.receipts.autonomy.success_criteria_receipts || 0);
  const criteriaPassRate = numOrNull(summary && summary.receipts && summary.receipts.autonomy && summary.receipts.autonomy.success_criteria_receipt_pass_rate);
  const admissions = countEligibleAdmissions(dateStr);
  const admissionEvidence = Number(admissions.eligible_admissions || 0) + attempted;

  return {
    date: dateStr,
    attempted,
    stop_ratio: stopRatio == null ? 0 : Number(stopRatio),
    reverted_rate: Number(revertedRate),
    success_criteria_receipts: criteriaReceipts,
    success_criteria_pass_rate: criteriaPassRate,
    eligible_admissions: Number(admissions.eligible_admissions || 0),
    proposals_scanned: Number(admissions.proposals_scanned || 0),
    admission_evidence: admissionEvidence
  };
}

function stat(values) {
  const nums = (values || []).map(numOrNull).filter((v) => v != null);
  if (!nums.length) return null;
  const mean = nums.reduce((acc, v) => acc + v, 0) / nums.length;
  const variance = nums.length > 1
    ? nums.reduce((acc, v) => acc + Math.pow(v - mean, 2), 0) / (nums.length - 1)
    : 0;
  const sd = Math.sqrt(Math.max(0, variance));
  return {
    n: nums.length,
    mean: Number(mean.toFixed(6)),
    sd: Number(sd.toFixed(6))
  };
}

function maxControlLimit(st, sigma, staticLimit) {
  if (!st || !Number.isFinite(Number(st.mean)) || !Number.isFinite(Number(st.sd))) return Number(staticLimit);
  const dynamic = Number(st.mean) + (Number(sigma) * Number(st.sd));
  return Number(Math.min(Number(staticLimit), dynamic).toFixed(6));
}

function minControlLimit(st, sigma, staticLimit) {
  if (!st || !Number.isFinite(Number(st.mean)) || !Number.isFinite(Number(st.sd))) return Number(staticLimit);
  const dynamic = Number(st.mean) - (Number(sigma) * Number(st.sd));
  return Number(Math.max(Number(staticLimit), dynamic).toFixed(6));
}

function evaluatePipelineSpcGate(dateStr, options = {}) {
  const opts = (options && typeof options === 'object' ? options : {}) as Record<string, any>;
  const endDate = isDateStr(dateStr) ? String(dateStr) : todayStr();
  const days = clampInt(opts.days, 1, 30, 1);
  const baselineDays = clampInt(opts.baseline_days, 3, 90, SPC_BASELINE_DAYS);
  const baselineMinDays = clampInt(opts.baseline_min_days, 1, baselineDays, SPC_BASELINE_MIN_DAYS);
  const sigma = Number.isFinite(Number(opts.sigma)) ? Number(opts.sigma) : SPC_SIGMA;

  const current = metricForDate(endDate, days);
  const baselineEnd = shiftDate(endDate, -1);
  const baselineDates = buildDates(baselineEnd, baselineDays);
  const baselineDaily = baselineDates.map((d) => metricForDate(d, 1));

  const attemptedStats = stat(baselineDaily.map((m) => m.attempted));
  const admissionStats = stat(baselineDaily.map((m) => m.admission_evidence));
  const stopStats = stat(baselineDaily.map((m) => m.stop_ratio));
  const revertedStats = stat(baselineDaily.map((m) => m.reverted_rate));
  const criteriaReceiptStats = stat(baselineDaily.map((m) => m.success_criteria_receipts));
  const criteriaPassStats = stat(
    baselineDaily
      .filter((m) => Number(m.success_criteria_receipts || 0) >= 1 && Number.isFinite(Number(m.success_criteria_pass_rate)))
      .map((m) => m.success_criteria_pass_rate)
  );

  const enoughBaseline = (attemptedStats && attemptedStats.n >= baselineMinDays) ? true : false;
  const limitSource = enoughBaseline ? 'spc_control_limit' : 'static_fallback';

  const limits = {
    min_attempted: enoughBaseline
      ? minControlLimit(attemptedStats, sigma, SPC_MIN_ATTEMPTED)
      : Number(SPC_MIN_ATTEMPTED),
    min_admission_evidence: enoughBaseline
      ? minControlLimit(admissionStats, sigma, SPC_MIN_ADMISSION_EVIDENCE)
      : Number(SPC_MIN_ADMISSION_EVIDENCE),
    max_stop_ratio: enoughBaseline
      ? maxControlLimit(stopStats, sigma, SPC_MAX_STOP_RATIO)
      : Number(SPC_MAX_STOP_RATIO),
    max_reverted_rate: enoughBaseline
      ? maxControlLimit(revertedStats, sigma, SPC_MAX_REVERTED_RATE)
      : Number(SPC_MAX_REVERTED_RATE),
    min_success_criteria_receipts: enoughBaseline
      ? minControlLimit(criteriaReceiptStats, sigma, SPC_MIN_SUCCESS_CRITERIA_RECEIPTS)
      : Number(SPC_MIN_SUCCESS_CRITERIA_RECEIPTS),
    min_success_criteria_pass_rate: enoughBaseline
      ? minControlLimit(criteriaPassStats, sigma, SPC_MIN_SUCCESS_CRITERIA_PASS_RATE)
      : Number(SPC_MIN_SUCCESS_CRITERIA_PASS_RATE)
  };

  const checks = [
    {
      name: 'attempted',
      pass: Number(current.attempted || 0) >= Number(limits.min_attempted || 0),
      value: Number(current.attempted || 0),
      target: `>=${Number(limits.min_attempted || 0)}`,
      source: limitSource
    },
    {
      name: 'admission_evidence',
      pass: Number(current.admission_evidence || 0) >= Number(limits.min_admission_evidence || 0),
      value: Number(current.admission_evidence || 0),
      target: `>=${Number(limits.min_admission_evidence || 0)}`,
      source: limitSource
    },
    {
      name: 'stop_ratio',
      pass: Number(current.stop_ratio || 0) <= Number(limits.max_stop_ratio || 1),
      value: Number(current.stop_ratio || 0),
      target: `<=${Number(limits.max_stop_ratio || 1)}`,
      source: limitSource
    },
    {
      name: 'reverted_rate',
      pass: Number(current.reverted_rate || 0) <= Number(limits.max_reverted_rate || 1),
      value: Number(current.reverted_rate || 0),
      target: `<=${Number(limits.max_reverted_rate || 1)}`,
      source: limitSource
    },
    {
      name: 'success_criteria_receipts',
      pass: Number(current.success_criteria_receipts || 0) >= Number(limits.min_success_criteria_receipts || 0),
      value: Number(current.success_criteria_receipts || 0),
      target: `>=${Number(limits.min_success_criteria_receipts || 0)}`,
      source: limitSource
    },
    {
      name: 'success_criteria_pass_rate',
      pass: Number(current.success_criteria_receipts || 0) >= Number(limits.min_success_criteria_receipts || 0)
        && Number(current.success_criteria_pass_rate || 0) >= Number(limits.min_success_criteria_pass_rate || 0),
      value: Number(current.success_criteria_receipts || 0) >= Number(limits.min_success_criteria_receipts || 0)
        ? Number(current.success_criteria_pass_rate || 0)
        : null,
      target: Number(current.success_criteria_receipts || 0) >= Number(limits.min_success_criteria_receipts || 0)
        ? `>=${Number(limits.min_success_criteria_pass_rate || 0)}`
        : `requires_receipts>=${Number(limits.min_success_criteria_receipts || 0)}`,
      source: limitSource
    }
  ];
  const failedChecks = checks.filter((c) => c.pass !== true).map((c) => c.name);

  return {
    ok: true,
    date: endDate,
    pass: failedChecks.length === 0,
    hold_escalation: failedChecks.length > 0,
    failed_checks: failedChecks,
    checks,
    current,
    control: {
      source: limitSource,
      sigma,
      baseline_days: baselineDays,
      baseline_min_days: baselineMinDays,
      baseline_samples: attemptedStats ? Number(attemptedStats.n || 0) : 0,
      limits,
      baselines: {
        attempted: attemptedStats,
        admission_evidence: admissionStats,
        stop_ratio: stopStats,
        reverted_rate: revertedStats,
        success_criteria_receipts: criteriaReceiptStats,
        success_criteria_pass_rate: criteriaPassStats
      }
    }
  };
}

function cmdRun(args) {
  const dateStr = isDateStr(args._[1]) ? String(args._[1]) : todayStr();
  const out = evaluatePipelineSpcGate(dateStr, {
    days: args.days,
    baseline_days: args['baseline-days'] || args.baseline_days,
    baseline_min_days: args['baseline-min-days'] || args.baseline_min_days,
    sigma: args.sigma
  });
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim();
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'run') return cmdRun(args);
  usage();
  process.exit(2);
}

if (require.main === module) {
  main();
}

module.exports = {
  evaluatePipelineSpcGate
};
export {};
