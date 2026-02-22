#!/usr/bin/env node
// @ts-nocheck
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
const { successCriteriaFromReceipt } = require('../../lib/autonomy_receipt_schema.js');

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
const SUCCESS_CRITERIA_MIN_CONTRACT_VERSION = String(
  process.env.AUTONOMY_SUCCESS_CRITERIA_MIN_CONTRACT_VERSION || '1.0'
).trim() || '1.0';
const SUCCESS_CRITERIA_MAX_UNKNOWN_RATE = Math.max(
  0,
  Math.min(1, Number(process.env.AUTONOMY_SUCCESS_CRITERIA_MAX_UNKNOWN_RATE || 0.4))
);
const SUCCESS_CRITERIA_MAX_UNSUPPORTED_RATE = Math.max(
  0,
  Math.min(1, Number(process.env.AUTONOMY_SUCCESS_CRITERIA_MAX_UNSUPPORTED_RATE || 0.5))
);

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

function parseVersionParts(v) {
  const m = String(v == null ? '' : v).trim().match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!m) return null;
  return [
    Number(m[1] || 0),
    Number(m[2] || 0),
    Number(m[3] || 0)
  ];
}

function versionAtLeast(version, minVersion) {
  const a = parseVersionParts(version);
  const b = parseVersionParts(minVersion);
  if (!a || !b) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const av = Number(a[i] || 0);
    const bv = Number(b[i] || 0);
    if (av > bv) return true;
    if (av < bv) return false;
  }
  return true;
}

function criteriaUnknownRate(criteria, checks) {
  const totalCount = Number(criteria && criteria.total_count || 0);
  const unknownCount = Number(criteria && criteria.unknown_count || 0);
  if (totalCount > 0) return unknownCount / totalCount;
  if (Array.isArray(checks) && checks.length > 0) {
    const unknownChecks = checks.filter((row) => !(row && row.evaluated === true)).length;
    return unknownChecks / checks.length;
  }
  const evaluatedCount = Number(criteria && criteria.evaluated_count || 0);
  return evaluatedCount > 0 ? 0 : 1;
}

function criteriaUnsupportedRate(checks) {
  if (!Array.isArray(checks) || checks.length <= 0) return 0;
  const unsupported = checks.filter((row) => String(row && row.reason || '') === 'unsupported_metric').length;
  return unsupported / checks.length;
}

function assessCriteriaQuality(rec, criteria) {
  const contract = rec && rec.receipt_contract && typeof rec.receipt_contract === 'object'
    ? rec.receipt_contract
    : {};
  const verification = rec && rec.verification && typeof rec.verification === 'object'
    ? rec.verification
    : {};
  const qualityFromReceipt = verification.criteria_quality && typeof verification.criteria_quality === 'object'
    ? verification.criteria_quality
    : null;
  const version = String(contract.version || '').trim();
  const versionKey = version || 'missing';
  const checks = Array.isArray(criteria && criteria.checks) ? criteria.checks : [];
  const unknownRate = qualityFromReceipt && Number.isFinite(Number(qualityFromReceipt.unknown_rate))
    ? Number(qualityFromReceipt.unknown_rate)
    : criteriaUnknownRate(criteria, checks);
  const unsupportedRate = qualityFromReceipt && Number.isFinite(Number(qualityFromReceipt.unsupported_rate))
    ? Number(qualityFromReceipt.unsupported_rate)
    : criteriaUnsupportedRate(checks);
  const reasons = [];

  if (!versionAtLeast(version, SUCCESS_CRITERIA_MIN_CONTRACT_VERSION)) {
    reasons.push('contract_version_below_min');
  }
  if (criteria && criteria.synthesized === true) reasons.push('synthesized_criteria');
  if (unknownRate > SUCCESS_CRITERIA_MAX_UNKNOWN_RATE) reasons.push('high_unknown_rate');
  if (unsupportedRate > SUCCESS_CRITERIA_MAX_UNSUPPORTED_RATE) reasons.push('high_unsupported_rate');
  if (verification.criteria_quality_insufficient === true) reasons.push('criteria_quality_insufficient_flag');
  if (qualityFromReceipt && Array.isArray(qualityFromReceipt.reasons)) {
    for (const reason of qualityFromReceipt.reasons) {
      const r = String(reason || '').trim();
      if (!r) continue;
      if (!reasons.includes(r)) reasons.push(r);
    }
  }

  return {
    quality_valid: reasons.length === 0,
    version: versionKey,
    unknown_rate: Number(unknownRate.toFixed(4)),
    unsupported_rate: Number(unsupportedRate.toFixed(4)),
    reasons
  };
}

function objectiveIdFromRun(run) {
  if (!run || typeof run !== 'object') return '';
  const direct = String(run.objective_id || '').trim();
  if (direct) return direct;
  const pulse = run.directive_pulse && typeof run.directive_pulse === 'object'
    ? run.directive_pulse
    : null;
  return String(pulse && pulse.objective_id || '').trim();
}

function objectiveIdFromReceipt(rec) {
  if (!rec || typeof rec !== 'object') return '';
  const intent = rec.intent && typeof rec.intent === 'object' ? rec.intent : {};
  const direct = String(intent.objective_id || '').trim();
  if (direct) return direct;
  const directiveValidation = intent.directive_validation && typeof intent.directive_validation === 'object'
    ? intent.directive_validation
    : null;
  return String(directiveValidation && directiveValidation.objective_id || '').trim();
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
  const objectiveScorecard = {};
  for (const run of runs) {
    const objectiveId = objectiveIdFromRun(run);
    if (!objectiveId) continue;
    if (!objectiveScorecard[objectiveId]) {
      objectiveScorecard[objectiveId] = {
        attempts: 0,
        executed: 0,
        previews: 0,
        stopped: 0,
        shipped: 0,
        no_change: 0,
        reverted: 0,
        pulse_score_avg: null,
        objective_allocation_score_avg: null,
        latest_result: null,
        latest_ts: null
      };
    }
    const row = objectiveScorecard[objectiveId];
    row.attempts += 1;
    const result = String(run.result || '');
    if (result === 'executed') {
      row.executed += 1;
      const outcome = String(run.outcome || '');
      if (outcome === 'shipped') row.shipped += 1;
      else if (outcome === 'no_change') row.no_change += 1;
      else if (outcome === 'reverted') row.reverted += 1;
    } else if (result === 'score_only_preview' || result === 'score_only_evidence') {
      row.previews += 1;
    } else if (result.startsWith('stop_') || result.startsWith('init_gate_')) {
      row.stopped += 1;
    }
    if (!row._pulse_score_total) row._pulse_score_total = 0;
    if (!row._pulse_score_samples) row._pulse_score_samples = 0;
    if (!row._allocation_total) row._allocation_total = 0;
    if (!row._allocation_samples) row._allocation_samples = 0;
    const pulse = run.directive_pulse && typeof run.directive_pulse === 'object'
      ? run.directive_pulse
      : null;
    const pulseScore = Number(pulse && pulse.score);
    if (Number.isFinite(pulseScore)) {
      row._pulse_score_total += pulseScore;
      row._pulse_score_samples += 1;
    }
    const allocationScore = Number(pulse && pulse.objective_allocation_score);
    if (Number.isFinite(allocationScore)) {
      row._allocation_total += allocationScore;
      row._allocation_samples += 1;
    }
    row.latest_result = result || row.latest_result;
    row.latest_ts = String(run.ts || row.latest_ts || '') || row.latest_ts;
  }
  const objectiveScorecardSorted = Object.fromEntries(
    Object.entries(objectiveScorecard)
      .map(([objectiveId, row]) => {
        const pulseSamples = Number(row._pulse_score_samples || 0);
        const allocationSamples = Number(row._allocation_samples || 0);
        const clean = {
          attempts: Number(row.attempts || 0),
          executed: Number(row.executed || 0),
          previews: Number(row.previews || 0),
          stopped: Number(row.stopped || 0),
          shipped: Number(row.shipped || 0),
          no_change: Number(row.no_change || 0),
          reverted: Number(row.reverted || 0),
          ship_rate: row.executed > 0 ? Number((row.shipped / row.executed).toFixed(3)) : null,
          no_progress_rate: row.executed > 0 ? Number(((row.no_change + row.reverted) / row.executed).toFixed(3)) : null,
          pulse_score_avg: pulseSamples > 0 ? Number((row._pulse_score_total / pulseSamples).toFixed(3)) : null,
          objective_allocation_score_avg: allocationSamples > 0 ? Number((row._allocation_total / allocationSamples).toFixed(3)) : null,
          latest_result: row.latest_result || null,
          latest_ts: row.latest_ts || null
        };
        return [objectiveId, clean];
      })
      .sort((a, b) => {
        const at = Number(a[1] && a[1].attempts || 0);
        const bt = Number(b[1] && b[1].attempts || 0);
        if (bt !== at) return bt - at;
        return String(a[0]).localeCompare(String(b[0]));
      })
  );
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
    objective_scorecard: objectiveScorecardSorted,
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
  let previewReceipts = 0;
  let previewCriteriaReceipts = 0;
  let previewCriteriaPass = 0;
  let qualityCriteriaReceipts = 0;
  let qualityCriteriaPass = 0;
  let previewQualityCriteriaReceipts = 0;
  let previewQualityCriteriaPass = 0;
  let qualityFilteredReceipts = 0;
  let qualityInsufficientReceipts = 0;
  let criteriaSynthesizedReceipts = 0;
  const qualityFilterReasons = {};
  const criteriaContractVersions = {};
  const byObjective = {};

  for (const rec of receipts) {
    const intent = rec && rec.intent && typeof rec.intent === 'object' ? rec.intent : {};
    const isPreview = intent.score_only === true;
    if (isPreview) previewReceipts += 1;
    const objectiveId = objectiveIdFromReceipt(rec);
    if (objectiveId) {
      if (!byObjective[objectiveId]) {
        byObjective[objectiveId] = {
          total: 0,
          pass: 0,
          fail: 0,
          success_criteria_receipts: 0,
          success_criteria_pass: 0
        };
      }
      const bucket = byObjective[objectiveId];
      bucket.total += 1;
      if (String(rec.verdict || '').toLowerCase() === 'pass') bucket.pass += 1;
      else if (String(rec.verdict || '').toLowerCase() === 'fail') bucket.fail += 1;
    }
    const criteria = successCriteriaFromReceipt(rec);
    if (!criteria) continue;
    const quality = assessCriteriaQuality(rec, criteria);
    criteriaContractVersions[quality.version] = Number(criteriaContractVersions[quality.version] || 0) + 1;
    if (quality.reasons.includes('criteria_quality_insufficient_flag')) {
      qualityInsufficientReceipts += 1;
    }
    if (quality.quality_valid !== true) {
      qualityFilteredReceipts += 1;
      for (const reason of quality.reasons) {
        qualityFilterReasons[reason] = Number(qualityFilterReasons[reason] || 0) + 1;
      }
    }
    if (criteria.synthesized === true) criteriaSynthesizedReceipts += 1;
    criteriaReceipts += 1;
    if (criteria.required === true) criteriaRequiredReceipts += 1;
    if (criteria.passed === true) criteriaReceiptPass += 1;
    if (isPreview) {
      previewCriteriaReceipts += 1;
      if (criteria.passed === true) previewCriteriaPass += 1;
    }
    if (quality.quality_valid === true) {
      qualityCriteriaReceipts += 1;
      if (criteria.passed === true) qualityCriteriaPass += 1;
      if (isPreview) {
        previewQualityCriteriaReceipts += 1;
        if (criteria.passed === true) previewQualityCriteriaPass += 1;
      }
    }
    criteriaRowsTotal += Number(criteria.total_count || 0);
    criteriaRowsEvaluated += Number(criteria.evaluated_count || 0);
    criteriaRowsPassed += Number(criteria.passed_count || 0);
    criteriaRowsFailed += Number(criteria.failed_count || 0);
    criteriaRowsUnknown += Number(criteria.unknown_count || 0);
    if (objectiveId) {
      const bucket = byObjective[objectiveId];
      bucket.success_criteria_receipts += 1;
      if (criteria.passed === true) bucket.success_criteria_pass += 1;
    }
  }

  const byObjectiveSorted = Object.fromEntries(
    Object.entries(byObjective)
      .map(([id, row]) => [id, {
        total: Number(row.total || 0),
        pass: Number(row.pass || 0),
        fail: Number(row.fail || 0),
        pass_rate: row.total > 0 ? Number((row.pass / row.total).toFixed(3)) : null,
        success_criteria_receipts: Number(row.success_criteria_receipts || 0),
        success_criteria_pass_rate: row.success_criteria_receipts > 0
          ? Number((row.success_criteria_pass / row.success_criteria_receipts).toFixed(3))
          : null
      }])
      .sort((a, b) => {
        const at = Number(a[1] && a[1].total || 0);
        const bt = Number(b[1] && b[1].total || 0);
        if (bt !== at) return bt - at;
        return String(a[0]).localeCompare(String(b[0]));
      })
  );

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
      : null,
    preview_receipts: previewReceipts,
    success_criteria_preview_receipts: previewCriteriaReceipts,
    success_criteria_preview_pass: previewCriteriaPass,
    success_criteria_preview_pass_rate: previewCriteriaReceipts
      ? Number((previewCriteriaPass / previewCriteriaReceipts).toFixed(3))
      : null,
    success_criteria_quality_receipts: qualityCriteriaReceipts,
    success_criteria_quality_receipt_pass: qualityCriteriaPass,
    success_criteria_quality_receipt_pass_rate: qualityCriteriaReceipts
      ? Number((qualityCriteriaPass / qualityCriteriaReceipts).toFixed(3))
      : null,
    success_criteria_quality_preview_receipts: previewQualityCriteriaReceipts,
    success_criteria_quality_preview_pass: previewQualityCriteriaPass,
    success_criteria_quality_preview_pass_rate: previewQualityCriteriaReceipts
      ? Number((previewQualityCriteriaPass / previewQualityCriteriaReceipts).toFixed(3))
      : null,
    success_criteria_quality_filtered_receipts: qualityFilteredReceipts,
    success_criteria_quality_insufficient_receipts: qualityInsufficientReceipts,
    success_criteria_quality_insufficient_rate: criteriaReceipts > 0
      ? Number((qualityFilteredReceipts / criteriaReceipts).toFixed(3))
      : null,
    success_criteria_quality_filter_reasons: sortedTally(qualityFilterReasons),
    success_criteria_contract_versions: sortedTally(criteriaContractVersions),
    success_criteria_quality_policy: {
      min_contract_version: SUCCESS_CRITERIA_MIN_CONTRACT_VERSION,
      max_unknown_rate: SUCCESS_CRITERIA_MAX_UNKNOWN_RATE,
      max_unsupported_rate: SUCCESS_CRITERIA_MAX_UNSUPPORTED_RATE
    },
    success_criteria_synthesized_receipts: criteriaSynthesizedReceipts,
    by_objective: byObjectiveSorted
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
        success_criteria_preview_pass_rate: autonomyReceipts.success_criteria_preview_pass_rate,
        success_criteria_quality_receipt_pass_rate: autonomyReceipts.success_criteria_quality_receipt_pass_rate,
        success_criteria_quality_preview_pass_rate: autonomyReceipts.success_criteria_quality_preview_pass_rate,
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
