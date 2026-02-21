#!/usr/bin/env node
'use strict';

/**
 * outcome_fitness_loop.js
 *
 * Deterministic realized-outcome loop:
 * - Scores outcome quality from autonomy runs + receipts
 * - Derives bounded adaptive policy updates for:
 *   - strategy ranking weights
 *   - proposal admission thresholds
 *   - focus gate sensitivity
 *   - proposal success-criteria filter strictness
 *
 * Usage:
 *   node systems/autonomy/outcome_fitness_loop.js run [YYYY-MM-DD] [--days=N] [--apply=1|0]
 *   node systems/autonomy/outcome_fitness_loop.js status [latest|YYYY-MM-DD]
 *   node systems/autonomy/outcome_fitness_loop.js --help
 */

const fs = require('fs');
const path = require('path');
const { listStrategies } = require('../../lib/strategy_resolver.js');
const { normalizeRankingWeights } = require('../../lib/outcome_fitness.js');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const RUNS_DIR = process.env.OUTCOME_FITNESS_RUNS_DIR
  ? path.resolve(process.env.OUTCOME_FITNESS_RUNS_DIR)
  : path.join(REPO_ROOT, 'state', 'autonomy', 'runs');
const RECEIPTS_DIR = process.env.OUTCOME_FITNESS_RECEIPTS_DIR
  ? path.resolve(process.env.OUTCOME_FITNESS_RECEIPTS_DIR)
  : path.join(REPO_ROOT, 'state', 'autonomy', 'receipts');
const PROPOSALS_DIR = process.env.OUTCOME_FITNESS_PROPOSALS_DIR
  ? path.resolve(process.env.OUTCOME_FITNESS_PROPOSALS_DIR)
  : path.join(REPO_ROOT, 'state', 'sensory', 'proposals');
const STRATEGY_DIR = process.env.AUTONOMY_STRATEGY_DIR
  ? path.resolve(process.env.AUTONOMY_STRATEGY_DIR)
  : path.join(REPO_ROOT, 'config', 'strategies');
const OUT_DIR = process.env.OUTCOME_FITNESS_OUT_DIR
  ? path.resolve(process.env.OUTCOME_FITNESS_OUT_DIR)
  : path.join(REPO_ROOT, 'state', 'adaptive', 'strategy');
const LATEST_PATH = path.join(OUT_DIR, 'outcome_fitness.json');
const HISTORY_DIR = path.join(OUT_DIR, 'outcome_fitness');
const RECEIPTS_PATH = path.join(OUT_DIR, 'receipts.jsonl');
const TYPE_MIN_OUTCOME_SAMPLES = clampInt(process.env.OUTCOME_FITNESS_TYPE_MIN_OUTCOME_SAMPLES, 2, 30, 3);
const TYPE_OFFSET_LIMIT = clampInt(process.env.OUTCOME_FITNESS_TYPE_OFFSET_LIMIT, 1, 12, 4);

function nowIso() { return new Date().toISOString(); }
function todayStr() { return new Date().toISOString().slice(0, 10); }

function usage() {
  console.log('Usage:');
  console.log('  node systems/autonomy/outcome_fitness_loop.js run [YYYY-MM-DD] [--days=N] [--apply=1|0]');
  console.log('  node systems/autonomy/outcome_fitness_loop.js status [latest|YYYY-MM-DD]');
  console.log('  node systems/autonomy/outcome_fitness_loop.js --help');
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

function clampNumber(v, lo, hi, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function clampInt(v, lo, hi, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
}

function appendJsonl(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(obj)}\n`, 'utf8');
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

function shiftDate(dateStr, deltaDays) {
  const base = new Date(`${dateStr}T00:00:00.000Z`);
  if (Number.isNaN(base.getTime())) return dateStr;
  base.setUTCDate(base.getUTCDate() + Number(deltaDays || 0));
  return base.toISOString().slice(0, 10);
}

function windowDates(endDate, days) {
  const out = [];
  for (let i = days - 1; i >= 0; i--) out.push(shiftDate(endDate, -i));
  return out;
}

function rate(num, den) {
  const n = Number(num || 0);
  const d = Number(den || 0);
  if (!Number.isFinite(n) || !Number.isFinite(d) || d <= 0) return 0;
  return Number((n / d).toFixed(4));
}

function normalizeProposalType(v) {
  const key = String(v || '').trim().toLowerCase();
  if (!key) return 'unknown';
  return key
    .replace(/[^a-z0-9_.:-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64) || 'unknown';
}

function loadActiveStrategyProfile() {
  const strategies = listStrategies({ dir: STRATEGY_DIR });
  const active = strategies.find((s) => String(s.status || '') === 'active') || strategies[0] || null;
  if (!active) return null;
  return active;
}

function summarizeRuns(dates) {
  const out = {
    total_runs: 0,
    attempted: 0,
    executed: 0,
    shipped: 0,
    no_change: 0,
    reverted: 0,
    stopped: 0
  };
  const receiptToStrategy = {};
  for (const dateStr of dates) {
    const rows = readJsonl(path.join(RUNS_DIR, `${dateStr}.jsonl`));
    for (const row of rows) {
      if (!row || row.type !== 'autonomy_run') continue;
      out.total_runs += 1;
      const result = String(row.result || '');
      const outcome = String(row.outcome || '');
      if (result === 'executed') out.executed += 1;
      if (result !== 'no_candidates') out.attempted += 1;
      if (result.startsWith('stop_')) out.stopped += 1;
      if (outcome === 'shipped') out.shipped += 1;
      if (outcome === 'no_change') out.no_change += 1;
      if (outcome === 'reverted') out.reverted += 1;
      if (row.receipt_id) {
        receiptToStrategy[String(row.receipt_id)] = String(row.strategy_id || 'unassigned');
      }
    }
  }
  out.shipped_rate = rate(out.shipped, out.executed);
  out.no_change_rate = rate(out.no_change, out.executed);
  out.reverted_rate = rate(out.reverted, out.executed);
  out.stop_ratio = rate(out.stopped, out.attempted);
  return { metrics: out, receipt_to_strategy: receiptToStrategy };
}

function summarizeTypeOutcomes(dates) {
  const byType = {};
  for (const dateStr of dates) {
    const rows = readJsonl(path.join(RUNS_DIR, `${dateStr}.jsonl`));
    for (const row of rows) {
      if (!row || row.type !== 'autonomy_run') continue;
      const proposalType = normalizeProposalType(row.proposal_type);
      const rec = byType[proposalType] || {
        proposal_type: proposalType,
        attempted: 0,
        executed: 0,
        shipped: 0,
        no_change: 0,
        reverted: 0,
        stopped: 0,
        outcome_samples: 0
      };
      const result = String(row.result || '');
      const outcome = String(row.outcome || '');
      if (result !== 'no_candidates') rec.attempted += 1;
      if (result === 'executed') rec.executed += 1;
      if (result.startsWith('stop_')) rec.stopped += 1;
      if (outcome === 'shipped' || outcome === 'no_change' || outcome === 'reverted') {
        rec.outcome_samples += 1;
        if (outcome === 'shipped') rec.shipped += 1;
        if (outcome === 'no_change') rec.no_change += 1;
        if (outcome === 'reverted') rec.reverted += 1;
      }
      byType[proposalType] = rec;
    }
  }

  const rows = Object.values(byType)
    .map((row) => ({
      ...row,
      shipped_rate: rate(row.shipped, row.outcome_samples),
      no_change_rate: rate(row.no_change, row.outcome_samples),
      reverted_rate: rate(row.reverted, row.outcome_samples),
      stop_ratio: rate(row.stopped, row.attempted)
    }))
    .sort((a, b) => {
      const sa = Number(b.outcome_samples || 0) - Number(a.outcome_samples || 0);
      if (sa !== 0) return sa;
      return String(a.proposal_type).localeCompare(String(b.proposal_type));
    });

  return {
    min_outcome_samples: TYPE_MIN_OUTCOME_SAMPLES,
    rows
  };
}

function summarizeReceipts(dates) {
  const out = {
    total: 0,
    attempted: 0,
    verified: 0,
    pass: 0,
    fail: 0,
    verification_passed: 0,
    outcome_shipped: 0,
    success_criteria_receipts: 0,
    success_criteria_required_receipts: 0,
    success_criteria_receipt_pass: 0,
    success_criteria_rows_total: 0,
    success_criteria_rows_evaluated: 0,
    success_criteria_rows_passed: 0,
    success_criteria_rows_failed: 0,
    success_criteria_rows_unknown: 0
  };
  for (const dateStr of dates) {
    const rows = readJsonl(path.join(RECEIPTS_DIR, `${dateStr}.jsonl`));
    for (const row of rows) {
      if (!row || row.type !== 'autonomy_action_receipt') continue;
      out.total += 1;
      const contract = row.receipt_contract && typeof row.receipt_contract === 'object'
        ? row.receipt_contract
        : {};
      const attempted = contract.attempted !== false;
      if (!attempted) continue;
      out.attempted += 1;
      if (contract.verified === true) out.verified += 1;
      const verdict = String(row.verdict || '').toLowerCase();
      if (verdict === 'pass') out.pass += 1;
      if (verdict === 'fail') out.fail += 1;
      const verification = row.verification && typeof row.verification === 'object'
        ? row.verification
        : {};
      if (verification.passed === true) out.verification_passed += 1;
      if (String(verification.outcome || '').toLowerCase() === 'shipped') out.outcome_shipped += 1;
      const criteria = verification.success_criteria && typeof verification.success_criteria === 'object'
        ? verification.success_criteria
        : null;
      if (criteria) {
        out.success_criteria_receipts += 1;
        if (criteria.required === true) out.success_criteria_required_receipts += 1;
        if (criteria.passed === true) out.success_criteria_receipt_pass += 1;
        out.success_criteria_rows_total += Number(criteria.total_count || 0);
        out.success_criteria_rows_evaluated += Number(criteria.evaluated_count || 0);
        out.success_criteria_rows_passed += Number(criteria.passed_count || 0);
        out.success_criteria_rows_failed += Number(criteria.failed_count || 0);
        out.success_criteria_rows_unknown += Number(criteria.unknown_count || 0);
      }
    }
  }
  out.verified_rate = rate(out.verified, out.attempted);
  out.pass_rate = rate(out.pass, out.attempted);
  out.verification_pass_rate = rate(out.verification_passed, out.attempted);
  out.fail_rate = rate(out.fail, out.attempted);
  out.receipt_shipped_rate = rate(out.outcome_shipped, out.attempted);
  out.success_criteria_receipt_pass_rate = rate(out.success_criteria_receipt_pass, out.success_criteria_receipts);
  out.success_criteria_required_pass_rate = rate(out.success_criteria_receipt_pass, out.success_criteria_required_receipts);
  out.success_criteria_row_pass_rate = rate(out.success_criteria_rows_passed, out.success_criteria_rows_evaluated);
  return out;
}

function summarizeProposalBlocks(dates) {
  const tally = {};
  let blockedTotal = 0;
  for (const dateStr of dates) {
    const payload = readJson(path.join(PROPOSALS_DIR, `${dateStr}.json`), []);
    const rows = Array.isArray(payload) ? payload : (payload && Array.isArray(payload.proposals) ? payload.proposals : []);
    for (const row of rows) {
      const blocked = row && row.meta && row.meta.admission_preview && Array.isArray(row.meta.admission_preview.blocked_by)
        ? row.meta.admission_preview.blocked_by
        : [];
      if (!blocked.length) continue;
      blockedTotal += 1;
      for (const reason of blocked) {
        const key = String(reason || 'unknown').trim() || 'unknown';
        tally[key] = Number(tally[key] || 0) + 1;
      }
    }
  }
  const blockedByReason = Object.fromEntries(
    Object.entries(tally).sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0) || String(a[0]).localeCompare(String(b[0])))
  );
  return { blocked_total: blockedTotal, blocked_by_reason: blockedByReason };
}

function normalizeThresholds(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    min_directive_fit: clampInt(src.min_directive_fit, 25, 90, 40),
    min_actionability_score: clampInt(src.min_actionability_score, 25, 90, 45),
    min_composite_eligibility: clampInt(src.min_composite_eligibility, 40, 95, 62)
  };
}

function deriveThresholdOverrides(base, runMetrics, receiptMetrics, blocks) {
  const next = normalizeThresholds(base);
  const blocked = blocks && blocks.blocked_by_reason ? blocks.blocked_by_reason : {};
  const blockedTotal = Math.max(1, Number(blocks && blocks.blocked_total || 0));
  const actionabilityShare = Number(blocked.actionability_low || 0) / blockedTotal;
  const directiveShare = Number(blocked.directive_fit_low || 0) / blockedTotal;
  const compositeShare = Number(blocked.composite_low || 0) / blockedTotal;

  const criteriaWeak = Number(receiptMetrics.success_criteria_receipts || 0) >= 2
    && Number(receiptMetrics.success_criteria_receipt_pass_rate || 0) < 0.6;
  const tighten = runMetrics.reverted_rate >= 0.25 || receiptMetrics.fail_rate >= 0.35 || criteriaWeak;
  const loosen = !tighten && (runMetrics.executed < 3 || runMetrics.shipped_rate < 0.2);

  if (tighten) {
    next.min_actionability_score += 2;
    next.min_composite_eligibility += 2;
    next.min_directive_fit += 1;
  } else if (loosen) {
    next.min_actionability_score -= 2;
    next.min_composite_eligibility -= 2;
    next.min_directive_fit -= 1;
  }

  if (!tighten && actionabilityShare >= 0.3) next.min_actionability_score -= 1;
  if (!tighten && directiveShare >= 0.3) next.min_directive_fit -= 1;
  if (!tighten && compositeShare >= 0.3) next.min_composite_eligibility -= 1;

  return {
    min_directive_fit: clampInt(next.min_directive_fit, 30, 85, 40),
    min_actionability_score: clampInt(next.min_actionability_score, 32, 85, 45),
    min_composite_eligibility: clampInt(next.min_composite_eligibility, 50, 90, 62)
  };
}

function deriveTypeThresholdOffsets(typeSummary) {
  const rows = typeSummary && Array.isArray(typeSummary.rows) ? typeSummary.rows : [];
  const offsets = {};
  const audit = {};
  for (const row of rows) {
    const sample = Number(row.outcome_samples || 0);
    if (sample < TYPE_MIN_OUTCOME_SAMPLES) continue;

    const shippedRate = Number(row.shipped_rate || 0);
    const noChangeRate = Number(row.no_change_rate || 0);
    const revertedRate = Number(row.reverted_rate || 0);

    const delta = {
      min_directive_fit: 0,
      min_actionability_score: 0,
      min_composite_eligibility: 0
    };
    const reasons = [];

    if (revertedRate >= 0.2 || (noChangeRate >= 0.65 && shippedRate <= 0.2)) {
      delta.min_actionability_score += 2;
      delta.min_composite_eligibility += 2;
      delta.min_directive_fit += 1;
      reasons.push('tighten_for_reverted_or_high_no_change');
    } else if (shippedRate >= 0.55 && noChangeRate <= 0.3 && revertedRate <= 0.1) {
      delta.min_actionability_score -= 1;
      delta.min_composite_eligibility -= 1;
      reasons.push('loosen_for_consistent_shipping');
    }

    if (noChangeRate >= 0.5) {
      delta.min_composite_eligibility += 1;
      reasons.push('tighten_composite_for_no_change');
    }
    if (noChangeRate >= 0.6) {
      delta.min_actionability_score += 1;
      reasons.push('tighten_actionability_for_no_change');
    }
    if (shippedRate >= 0.6 && noChangeRate <= 0.25) {
      delta.min_directive_fit -= 1;
      reasons.push('loosen_directive_for_high_shipping');
    }

    const bounded = {
      min_directive_fit: clampInt(delta.min_directive_fit, -TYPE_OFFSET_LIMIT, TYPE_OFFSET_LIMIT, 0),
      min_actionability_score: clampInt(delta.min_actionability_score, -TYPE_OFFSET_LIMIT, TYPE_OFFSET_LIMIT, 0),
      min_composite_eligibility: clampInt(delta.min_composite_eligibility, -TYPE_OFFSET_LIMIT, TYPE_OFFSET_LIMIT, 0)
    };

    const hasDelta = Object.values(bounded).some((v) => Number(v || 0) !== 0);
    if (!hasDelta) continue;
    offsets[row.proposal_type] = bounded;
    audit[row.proposal_type] = {
      sample,
      shipped_rate: shippedRate,
      no_change_rate: noChangeRate,
      reverted_rate: revertedRate,
      reasons
    };
  }

  return { offsets, audit };
}

function deriveRankingWeightOverride(baseWeights, runMetrics, receiptMetrics) {
  const w = {
    composite: Number(baseWeights.composite || 0),
    actionability: Number(baseWeights.actionability || 0),
    directive_fit: Number(baseWeights.directive_fit || 0),
    signal_quality: Number(baseWeights.signal_quality || 0),
    expected_value: Number(baseWeights.expected_value || 0),
    time_to_value: Number(baseWeights.time_to_value || 0),
    risk_penalty: Number(baseWeights.risk_penalty || 0)
  };

  if (runMetrics.no_change_rate > 0.45) {
    w.expected_value += 0.03;
    w.time_to_value += 0.02;
    w.composite -= 0.03;
    w.signal_quality -= 0.02;
  }
  if (runMetrics.reverted_rate > 0.2) {
    w.risk_penalty += 0.05;
    w.expected_value -= 0.02;
    w.actionability -= 0.01;
  }
  if (receiptMetrics.verified_rate < 0.7) {
    w.actionability += 0.03;
    w.directive_fit += 0.02;
    w.signal_quality -= 0.03;
    w.composite -= 0.02;
  }
  if (
    Number(receiptMetrics.success_criteria_receipts || 0) >= 2
    && Number(receiptMetrics.success_criteria_receipt_pass_rate || 0) < 0.65
  ) {
    w.actionability += 0.03;
    w.expected_value -= 0.02;
    w.composite -= 0.01;
  }
  if (runMetrics.shipped_rate > 0.4 && runMetrics.reverted_rate < 0.1) {
    w.expected_value += 0.03;
    w.time_to_value += 0.02;
    w.risk_penalty -= 0.02;
  }

  const bounded = {};
  for (const [key, value] of Object.entries(w)) {
    bounded[key] = Number(clampNumber(value, 0.001, 0.8, 0.01).toFixed(6));
  }
  return normalizeRankingWeights(bounded) || normalizeRankingWeights(baseWeights) || {
    composite: 0.35,
    actionability: 0.2,
    directive_fit: 0.15,
    signal_quality: 0.15,
    expected_value: 0.1,
    time_to_value: 0,
    risk_penalty: 0.05
  };
}

function deriveFocusDelta(runMetrics, blocks) {
  const blocked = blocks && blocks.blocked_by_reason ? blocks.blocked_by_reason : {};
  const blockedTotal = Math.max(1, Number(blocks && blocks.blocked_total || 0));
  const directiveShare = Number(blocked.directive_fit_low || 0) / blockedTotal;
  const qualityShare = (Number(blocked.actionability_low || 0) + Number(blocked.composite_low || 0)) / blockedTotal;
  if (directiveShare >= 0.35) return 3;
  if (qualityShare >= 0.45) return 2;
  if (runMetrics.executed < 2 && Number(blocks && blocks.blocked_total || 0) === 0) return -2;
  return 0;
}

function computeRealizedOutcomeScore(runMetrics, receiptMetrics) {
  const criteriaRate = Number(receiptMetrics.success_criteria_receipt_pass_rate || 0) > 0
    ? Number(receiptMetrics.success_criteria_receipt_pass_rate || 0)
    : Number(receiptMetrics.verification_pass_rate || 0);
  const score = (
    (Number(runMetrics.shipped_rate || 0) * 40)
    + (Number(receiptMetrics.verified_rate || 0) * 20)
    + (Number(receiptMetrics.verification_pass_rate || 0) * 20)
    + (criteriaRate * 15)
    + ((1 - Number(runMetrics.reverted_rate || 0)) * 5)
  );
  return Number(clampNumber(score, 0, 100, 0).toFixed(2));
}

function buildPayload(dateStr, days) {
  const dates = windowDates(dateStr, days);
  const strategy = loadActiveStrategyProfile();
  const strategyId = strategy ? String(strategy.id || '') : 'unassigned';
  const baseWeights = strategy && strategy.ranking_weights && typeof strategy.ranking_weights === 'object'
    ? strategy.ranking_weights
    : {
      composite: 0.35,
      actionability: 0.2,
      directive_fit: 0.15,
      signal_quality: 0.15,
      expected_value: 0.1,
      time_to_value: 0,
      risk_penalty: 0.05
    };
  const baseThresholds = strategy && strategy.threshold_overrides && typeof strategy.threshold_overrides === 'object'
    ? strategy.threshold_overrides
    : {};

  const runSummary = summarizeRuns(dates);
  const typeSummary = summarizeTypeOutcomes(dates);
  const receiptMetrics = summarizeReceipts(dates);
  const blockSummary = summarizeProposalBlocks(dates);
  const runMetrics = runSummary.metrics;
  const realizedScore = computeRealizedOutcomeScore(runMetrics, receiptMetrics);

  const thresholdOverrides = deriveThresholdOverrides(baseThresholds, runMetrics, receiptMetrics, blockSummary);
  const typeCalibration = deriveTypeThresholdOffsets(typeSummary);
  const rankingWeights = deriveRankingWeightOverride(baseWeights, runMetrics, receiptMetrics);
  const focusDelta = deriveFocusDelta(runMetrics, blockSummary);
  const minCriteriaCount = (
    receiptMetrics.verified_rate < 0.65
    || receiptMetrics.fail_rate > 0.3
    || (
      Number(receiptMetrics.success_criteria_receipts || 0) >= 2
      && Number(receiptMetrics.success_criteria_receipt_pass_rate || 0) < 0.65
    )
  ) ? 2 : 1;

  return {
    version: '1.0',
    ts: nowIso(),
    window: {
      end_date: dateStr,
      start_date: dates[0],
      days,
      dates
    },
    metrics: {
      runs: runMetrics,
      receipts: receiptMetrics,
      admission: blockSummary,
      proposal_type_outcomes: typeSummary
    },
    realized_outcome_score: realizedScore,
    strategy_policy: {
      strategy_id: strategyId || null,
      threshold_overrides: thresholdOverrides,
      proposal_type_threshold_offsets: typeCalibration.offsets,
      proposal_type_calibration_audit: typeCalibration.audit,
      ranking_weights_override: rankingWeights
    },
    focus_policy: {
      min_focus_score_delta: focusDelta
    },
    proposal_filter_policy: {
      require_success_criteria: true,
      min_success_criteria_count: minCriteriaCount
    }
  };
}

function runCmd(args) {
  const dateStr = isDateStr(args._[1]) ? String(args._[1]) : todayStr();
  const days = clampInt(args.days, 1, 30, 14);
  const apply = String(args.apply || '1') !== '0';
  const payload = buildPayload(dateStr, days);
  const historyPath = path.join(HISTORY_DIR, `${dateStr}.json`);

  const prevPayload = readJson(LATEST_PATH, null);
  if (apply) {
    writeJsonAtomic(LATEST_PATH, payload);
    writeJsonAtomic(historyPath, payload);
    const prevOffsets = prevPayload
      && prevPayload.strategy_policy
      && prevPayload.strategy_policy.proposal_type_threshold_offsets
      && typeof prevPayload.strategy_policy.proposal_type_threshold_offsets === 'object'
        ? prevPayload.strategy_policy.proposal_type_threshold_offsets
        : {};
    const nextOffsets = payload
      && payload.strategy_policy
      && payload.strategy_policy.proposal_type_threshold_offsets
      && typeof payload.strategy_policy.proposal_type_threshold_offsets === 'object'
        ? payload.strategy_policy.proposal_type_threshold_offsets
        : {};
    const changed = JSON.stringify(prevOffsets) !== JSON.stringify(nextOffsets);
    if (changed) {
      appendJsonl(RECEIPTS_PATH, {
        ts: nowIso(),
        type: 'proposal_type_threshold_calibration',
        date: dateStr,
        window_days: days,
        changed: true,
        previous_offsets: prevOffsets,
        next_offsets: nextOffsets,
        calibration_audit: payload.strategy_policy.proposal_type_calibration_audit || {}
      });
    }
  }

  process.stdout.write(JSON.stringify({
    ok: true,
    applied: apply,
    latest_path: apply ? LATEST_PATH : null,
    history_path: apply ? historyPath : null,
    ...payload
  }, null, 2) + '\n');
}

function statusCmd(args) {
  const key = String(args._[1] || 'latest').trim();
  const target = key === 'latest'
    ? LATEST_PATH
    : (isDateStr(key) ? path.join(HISTORY_DIR, `${key}.json`) : LATEST_PATH);
  const payload = readJson(target, null);
  if (!payload) {
    process.stdout.write(JSON.stringify({
      ok: false,
      error: 'outcome_fitness_not_found',
      path: target
    }) + '\n');
    process.exit(1);
  }
  process.stdout.write(JSON.stringify({ ok: true, path: target, ...payload }, null, 2) + '\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim().toLowerCase();
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'run') return runCmd(args);
  if (cmd === 'status') return statusCmd(args);
  usage();
  process.exit(2);
}

main();
