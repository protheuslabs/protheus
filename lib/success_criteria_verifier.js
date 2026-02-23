'use strict';

const { compileProposalSuccessCriteria } = require('./success_criteria_compiler.js');

const ALL_KNOWN_METRICS = new Set([
  'execution_success',
  'postconditions_ok',
  'queue_outcome_logged',
  'artifact_count',
  'entries_count',
  'revenue_actions_count',
  'token_usage',
  'duration_ms',
  'outreach_artifact',
  'reply_or_interview_count'
]);
const PROPOSAL_BASE_METRICS = new Set([
  'execution_success',
  'postconditions_ok',
  'queue_outcome_logged',
  'artifact_count',
  'entries_count',
  'revenue_actions_count',
  'token_usage',
  'duration_ms'
]);
const OUTREACH_METRICS = new Set([
  'outreach_artifact',
  'reply_or_interview_count'
]);
const OUTREACH_CAPABILITY_HINT_RE = /\b(opportunity|outreach|lead|sales|bizdev|revenue|freelance|contract|gig|external_intel|client|prospect)\b/;
const CONTRACT_SAFE_BACKFILL_ROWS = Object.freeze([
  { source: 'contract_backfill', metric: 'execution_success', target: 'execution success' },
  { source: 'contract_backfill', metric: 'postconditions_ok', target: 'postconditions pass' },
  { source: 'contract_backfill', metric: 'queue_outcome_logged', target: 'outcome receipt logged' }
]);

function clampInt(v, lo, hi, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

function normalizeText(v) {
  return String(v == null ? '' : v).trim();
}

function normalizeSpaces(v) {
  return normalizeText(v).replace(/\s+/g, ' ');
}

function normalizeCapabilityKey(v) {
  return normalizeSpaces(v).toLowerCase();
}

function capabilityMetricContract(capabilityKey) {
  const key = normalizeCapabilityKey(capabilityKey);
  if (!key) {
    return {
      capability_key: null,
      enforced: false,
      allowed_metrics: null
    };
  }
  if (key.startsWith('actuation:')) {
    return {
      capability_key: key,
      enforced: true,
      allowed_metrics: new Set(ALL_KNOWN_METRICS)
    };
  }
  if (key.startsWith('proposal:')) {
    const allowed = new Set(PROPOSAL_BASE_METRICS);
    if (OUTREACH_CAPABILITY_HINT_RE.test(key)) {
      for (const metric of OUTREACH_METRICS) allowed.add(metric);
    }
    return {
      capability_key: key,
      enforced: true,
      allowed_metrics: allowed
    };
  }
  return {
    capability_key: key,
    enforced: true,
    allowed_metrics: new Set(ALL_KNOWN_METRICS)
  };
}

function parseSuccessCriteriaRows(proposal, opts = {}) {
  const p = proposal && typeof proposal === 'object' ? proposal : {};
  const capabilityKey = normalizeCapabilityKey(opts && opts.capability_key);
  const compiledRows = compileProposalSuccessCriteria(p, {
    include_verify: true,
    include_validation: true,
    allow_fallback: true,
    capability_key: capabilityKey || ''
  });
  const rows = [];
  for (const row of compiledRows) {
    const metric = normalizeSpaces(row && row.metric || '').toLowerCase();
    const target = normalizeSpaces([
      String(row && row.target || ''),
      String(row && row.horizon || '')
    ].filter(Boolean).join(' | '));
    const merged = normalizeSpaces([metric, target].filter(Boolean).join(' | '));
    if (!merged) continue;
    rows.push({
      source: normalizeSpaces(row && row.source || '') || 'compiled',
      metric,
      target: target || metric || 'execution success'
    });
  }

  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const key = `${String(row.metric || '').toLowerCase()}|${String(row.target || '').toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function normalizeMetricName(v) {
  return String(v || '').toLowerCase().replace(/[\s-]+/g, '_');
}

function metricAllowedByContract(contract, metricName) {
  if (!contract || !(contract.allowed_metrics instanceof Set)) return false;
  const norm = normalizeMetricName(metricName);
  if (!norm) return false;
  return contract.allowed_metrics.has(norm);
}

function backfillContractSafeRows(rows, contract, minCount) {
  const list = Array.isArray(rows) ? rows.slice() : [];
  const min = clampInt(minCount, 0, 10, 0);
  if (min <= 0) return { rows: list, added_count: 0 };
  if (!contract || contract.enforced !== true || !(contract.allowed_metrics instanceof Set)) {
    return { rows: list, added_count: 0 };
  }

  const seen = new Set();
  for (const row of list) {
    const metric = normalizeMetricName(row && row.metric);
    const target = String(row && row.target || '').toLowerCase();
    seen.add(`${metric}|${target}`);
  }
  let supportedCount = list.filter((row) => metricAllowedByContract(contract, row && row.metric)).length;
  let added = 0;
  for (const candidate of CONTRACT_SAFE_BACKFILL_ROWS) {
    if (supportedCount >= min) break;
    if (!metricAllowedByContract(contract, candidate.metric)) continue;
    const key = `${normalizeMetricName(candidate.metric)}|${String(candidate.target || '').toLowerCase()}`;
    if (seen.has(key)) continue;
    list.push({
      source: String(candidate.source || 'contract_backfill'),
      metric: String(candidate.metric || ''),
      target: String(candidate.target || '')
    });
    seen.add(key);
    supportedCount += 1;
    added += 1;
  }
  return {
    rows: list,
    added_count: added
  };
}

function toNumberOrNull(v) {
  if (v == null) return null;
  if (typeof v === 'string' && v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function comparatorFromText(text, defaultComparator) {
  const t = String(text || '').toLowerCase();
  if (/(?:<=|≤|\bat most\b|\bwithin\b|\bunder\b|\bbelow\b|\bmax(?:imum)?\b|\bless than\b)/.test(t)) return 'lte';
  if (/(?:>=|≥|\bat least\b|\bover\b|\babove\b|\bminimum\b|\bmin\b|\bmore than\b)/.test(t)) return 'gte';
  return defaultComparator;
}

function parseDurationLimitMs(text) {
  const t = String(text || '').toLowerCase();
  const m = t.match(/(\d+(?:\.\d+)?)\s*(ms|msec|millisecond(?:s)?|s|sec|secs|second(?:s)?|m|min|mins|minute(?:s)?)/);
  if (!m) return null;
  let value = Number(m[1]);
  if (!Number.isFinite(value)) return null;
  const unit = String(m[2] || '');
  if (unit === 'm' || unit === 'min' || unit === 'mins' || unit.startsWith('minute')) value *= 60 * 1000;
  else if (unit === 's' || unit === 'sec' || unit === 'secs' || unit.startsWith('second')) value *= 1000;
  return Math.round(value);
}

function parseTokenLimit(text) {
  const t = String(text || '').toLowerCase();
  const mA = t.match(/(\d+(?:\.\d+)?)\s*(k|m)?\s*tokens?/);
  const mB = t.match(/tokens?\s*(?:<=|≥|>=|≤|<|>|=|at most|at least|under|over|below|above|within|max(?:imum)?|min(?:imum)?)?\s*(\d+(?:\.\d+)?)(?:\s*(k|m))?/);
  const m = mA || mB;
  if (!m) return null;
  const num = mA ? m[1] : m[1];
  let value = Number(num);
  if (!Number.isFinite(value)) return null;
  const suffix = String((mA ? m[2] : m[2]) || '').toLowerCase();
  if (suffix === 'k') value *= 1000;
  else if (suffix === 'm') value *= 1000000;
  return Math.round(value);
}

function compareNumeric(value, threshold, comparator) {
  const v = toNumberOrNull(value);
  const t = toNumberOrNull(threshold);
  if (v == null || t == null) return null;
  if (comparator === 'gte') return v >= t;
  return v <= t;
}

function parseFirstInt(text, fallback) {
  const m = String(text || '').match(/\b(\d+)\b/);
  if (!m) return fallback;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : fallback;
}

function readNumericMetric(ctx, keys) {
  const names = Array.isArray(keys) ? keys.filter(Boolean).map((k) => String(k)) : [];
  if (!names.length) return null;
  const top = ctx && typeof ctx === 'object' ? ctx : {};
  const metricValues = top.metric_values && typeof top.metric_values === 'object' ? top.metric_values : {};
  const dodDiff = top.dod_diff && typeof top.dod_diff === 'object' ? top.dod_diff : {};
  const sources = [metricValues, top, dodDiff];
  for (const name of names) {
    for (const src of sources) {
      if (!Object.prototype.hasOwnProperty.call(src, name)) continue;
      const n = toNumberOrNull(src[name]);
      if (n != null) return n;
    }
  }
  return null;
}

function evaluateRow(row, context) {
  const metric = String(row && row.metric || '').toLowerCase();
  const target = String(row && row.target || '');
  const text = `${metric} ${target}`.toLowerCase();
  const textWords = text.replace(/[_-]+/g, ' ');
  const metricNorm = metric.replace(/[\s-]+/g, '_');
  const ctx = context && typeof context === 'object' ? context : {};
  const outcome = String(ctx.outcome || '').toLowerCase();
  const execOk = ctx.exec_ok === true;
  const dodPassed = ctx.dod_passed === true;
  const postconditionsOk = ctx.postconditions_ok === true;
  const queueOutcomeLogged = ctx.queue_outcome_logged === true;
  const durationMs = toNumberOrNull(ctx.duration_ms);
  const tokenUsage = ctx.token_usage && typeof ctx.token_usage === 'object' ? ctx.token_usage : {};
  const effectiveTokens = toNumberOrNull(
    tokenUsage.effective_tokens != null
      ? tokenUsage.effective_tokens
      : (tokenUsage.actual_total_tokens != null ? tokenUsage.actual_total_tokens : tokenUsage.estimated_tokens)
  );
  const dodDiff = ctx.dod_diff && typeof ctx.dod_diff === 'object' ? ctx.dod_diff : {};
  const artifactsDelta = toNumberOrNull(dodDiff.artifacts_delta);
  const entriesDelta = toNumberOrNull(dodDiff.entries_delta);
  const revenueDelta = toNumberOrNull(dodDiff.revenue_actions_delta);

  const has = (re) => re.test(textWords);
  const boolResult = (pass, reason, details = {}) => ({
    evaluated: true,
    pass: pass === true,
    reason,
    ...details
  });
  const evaluateByMetricNorm = () => {
    if (metricNorm === 'execution_success') {
      return boolResult(execOk, 'requires_execution_success', { value: execOk, target: true });
    }
    if (metricNorm === 'postconditions_ok') {
      return boolResult(postconditionsOk, 'requires_postconditions_pass', { value: postconditionsOk, target: true });
    }
    if (metricNorm === 'queue_outcome_logged') {
      return boolResult(queueOutcomeLogged, 'requires_receipt_or_outcome_log', { value: queueOutcomeLogged, target: true });
    }
    if (metricNorm === 'artifact_count') {
      const threshold = parseFirstInt(text, 1);
      const comparator = comparatorFromText(text, 'gte');
      const pass = compareNumeric(artifactsDelta, threshold, comparator);
      if (pass == null) return { evaluated: false, pass: null, reason: 'artifact_delta_unavailable' };
      return boolResult(pass, 'artifact_delta_check', { comparator, value: artifactsDelta, target: threshold });
    }
    if (metricNorm === 'entries_count') {
      const threshold = parseFirstInt(text, 1);
      const comparator = comparatorFromText(text, 'gte');
      const pass = compareNumeric(entriesDelta, threshold, comparator);
      if (pass == null) return { evaluated: false, pass: null, reason: 'entry_delta_unavailable' };
      return boolResult(pass, 'entry_delta_check', { comparator, value: entriesDelta, target: threshold });
    }
    if (metricNorm === 'revenue_actions_count') {
      const threshold = parseFirstInt(text, 1);
      const comparator = comparatorFromText(text, 'gte');
      const pass = compareNumeric(revenueDelta, threshold, comparator);
      if (pass == null) return { evaluated: false, pass: null, reason: 'revenue_delta_unavailable' };
      return boolResult(pass, 'revenue_delta_check', { comparator, value: revenueDelta, target: threshold });
    }
    if (metricNorm === 'token_usage') {
      const limit = parseTokenLimit(text);
      if (limit == null) return { evaluated: false, pass: null, reason: 'token_limit_missing' };
      const comparator = comparatorFromText(text, 'lte');
      const pass = compareNumeric(effectiveTokens, limit, comparator);
      if (pass == null) return { evaluated: false, pass: null, reason: 'token_usage_unavailable' };
      return boolResult(pass, 'token_limit_check', { comparator, value: effectiveTokens, target: limit });
    }
    if (metricNorm === 'duration_ms') {
      const limitMs = parseDurationLimitMs(text);
      if (limitMs == null) return { evaluated: false, pass: null, reason: 'duration_limit_missing' };
      const comparator = comparatorFromText(text, 'lte');
      const pass = compareNumeric(durationMs, limitMs, comparator);
      if (pass == null) return { evaluated: false, pass: null, reason: 'duration_unavailable' };
      return boolResult(pass, 'duration_limit_check', { comparator, value: durationMs, target: limitMs, unit: 'ms' });
    }
    if (metricNorm === 'outreach_artifact') {
      const threshold = parseFirstInt(text, 1);
      const comparator = comparatorFromText(text, 'gte');
      const explicit = readNumericMetric(ctx, [
        'outreach_artifact',
        'outreach_artifact_count',
        'offer_draft_count',
        'proposal_draft_count'
      ]);
      const value = explicit != null ? explicit : artifactsDelta;
      const pass = compareNumeric(value, threshold, comparator);
      if (pass == null) return { evaluated: false, pass: null, reason: 'outreach_artifact_unavailable' };
      return boolResult(pass, 'outreach_artifact_check', { comparator, value, target: threshold });
    }
    if (metricNorm === 'reply_or_interview_count') {
      const threshold = parseFirstInt(text, 1);
      const comparator = comparatorFromText(text, 'gte');
      let value = readNumericMetric(ctx, ['reply_or_interview_count']);
      if (value == null) {
        const reply = readNumericMetric(ctx, ['reply_count', 'outreach_reply_count']);
        const interview = readNumericMetric(ctx, ['interview_count', 'outreach_interview_count']);
        if (reply != null || interview != null) value = Number(reply || 0) + Number(interview || 0);
      }
      const pass = compareNumeric(value, threshold, comparator);
      if (pass == null) return { evaluated: false, pass: null, reason: 'reply_or_interview_count_unavailable' };
      return boolResult(pass, 'reply_or_interview_count_check', { comparator, value, target: threshold });
    }
    return null;
  };

  const metricMapped = evaluateByMetricNorm();
  if (metricMapped) return metricMapped;

  if (has(/\b(ship|shipped|publish|posted|merged|applied|delivered)\b/)) {
    return boolResult(outcome === 'shipped', 'requires_shipped_outcome', { value: outcome || null, target: 'shipped' });
  }
  if (has(/\bno[\s_-]?change\b/)) {
    return boolResult(outcome === 'no_change', 'requires_no_change_outcome', { value: outcome || null, target: 'no_change' });
  }
  if (has(/\b(revert|rollback|undo)\b/) && has(/\b(no|without|avoid|prevent)\b/)) {
    return boolResult(outcome !== 'reverted', 'requires_non_reverted_outcome', { value: outcome || null, target: '!=reverted' });
  }
  if (has(/\b(execut(e|ed|ion)|run|runnable|exit[\s_-]?0|success)\b/)) {
    return boolResult(execOk, 'requires_execution_success', { value: execOk, target: true });
  }
  if (has(/\b(postcondition(?:s)?|contract|verify|verification|validated?|check(?:s)? pass)\b/)) {
    return boolResult(postconditionsOk, 'requires_postconditions_pass', { value: postconditionsOk, target: true });
  }
  if (has(/\b(dod|impact|delta)\b/)) {
    return boolResult(dodPassed, 'requires_dod_pass', { value: dodPassed, target: true });
  }

  if (has(/\bartifact(?:s)?\b/) && metricNorm !== 'outreach_artifact') {
    const threshold = (() => {
      const m = text.match(/\b(\d+)\b/);
      return m ? Number(m[1]) : 1;
    })();
    const comparator = comparatorFromText(text, 'gte');
    const pass = compareNumeric(artifactsDelta, threshold, comparator);
    if (pass == null) return { evaluated: false, pass: null, reason: 'artifact_delta_unavailable' };
    return boolResult(pass, 'artifact_delta_check', { comparator, value: artifactsDelta, target: threshold });
  }
  if (has(/\b(entries|entry|notes?)\b/)) {
    const threshold = (() => {
      const m = text.match(/\b(\d+)\b/);
      return m ? Number(m[1]) : 1;
    })();
    const comparator = comparatorFromText(text, 'gte');
    const pass = compareNumeric(entriesDelta, threshold, comparator);
    if (pass == null) return { evaluated: false, pass: null, reason: 'entry_delta_unavailable' };
    return boolResult(pass, 'entry_delta_check', { comparator, value: entriesDelta, target: threshold });
  }
  if (has(/\brevenue\b/)) {
    const threshold = parseFirstInt(text, 1);
    const comparator = comparatorFromText(text, 'gte');
    const pass = compareNumeric(revenueDelta, threshold, comparator);
    if (pass == null) return { evaluated: false, pass: null, reason: 'revenue_delta_unavailable' };
    return boolResult(pass, 'revenue_delta_check', { comparator, value: revenueDelta, target: threshold });
  }
  if (
    metricNorm === 'outreach_artifact'
    || (has(/\boutreach\b/) && has(/\b(artifact|draft|offer|proposal)\b/))
    || (has(/\b(draft|offer|proposal)\b/) && has(/\b(build|generate|generated|create|created|artifact)\b/))
  ) {
    const threshold = parseFirstInt(text, 1);
    const comparator = comparatorFromText(text, 'gte');
    const explicit = readNumericMetric(ctx, [
      'outreach_artifact',
      'outreach_artifact_count',
      'offer_draft_count',
      'proposal_draft_count'
    ]);
    const value = explicit != null ? explicit : artifactsDelta;
    const pass = compareNumeric(value, threshold, comparator);
    if (pass == null) return { evaluated: false, pass: null, reason: 'outreach_artifact_unavailable' };
    return boolResult(pass, 'outreach_artifact_check', { comparator, value, target: threshold });
  }
  if (
    metricNorm === 'reply_or_interview_count'
    || (has(/\b(reply|interview)\b/) && has(/\b(count|signal|response|kpi)\b/))
  ) {
    const threshold = parseFirstInt(text, 1);
    const comparator = comparatorFromText(text, 'gte');
    let value = readNumericMetric(ctx, ['reply_or_interview_count']);
    if (value == null) {
      const reply = readNumericMetric(ctx, ['reply_count', 'outreach_reply_count']);
      const interview = readNumericMetric(ctx, ['interview_count', 'outreach_interview_count']);
      if (reply != null || interview != null) value = Number(reply || 0) + Number(interview || 0);
    }
    const pass = compareNumeric(value, threshold, comparator);
    if (pass == null) return { evaluated: false, pass: null, reason: 'reply_or_interview_count_unavailable' };
    return boolResult(pass, 'reply_or_interview_count_check', { comparator, value, target: threshold });
  }
  if (has(/\b(token|tokens)\b/)) {
    const limit = parseTokenLimit(text);
    if (limit == null) return { evaluated: false, pass: null, reason: 'token_limit_missing' };
    const comparator = comparatorFromText(text, 'lte');
    const pass = compareNumeric(effectiveTokens, limit, comparator);
    if (pass == null) return { evaluated: false, pass: null, reason: 'token_usage_unavailable' };
    return boolResult(pass, 'token_limit_check', { comparator, value: effectiveTokens, target: limit });
  }
  if (has(/\b(latency|duration|time|ms|msec|millisecond|second|sec|min|minute)\b/)) {
    const limitMs = parseDurationLimitMs(text);
    if (limitMs == null) return { evaluated: false, pass: null, reason: 'duration_limit_missing' };
    const comparator = comparatorFromText(text, 'lte');
    const pass = compareNumeric(durationMs, limitMs, comparator);
    if (pass == null) return { evaluated: false, pass: null, reason: 'duration_unavailable' };
    return boolResult(pass, 'duration_limit_check', { comparator, value: durationMs, target: limitMs, unit: 'ms' });
  }
  if (has(/\b(receipt|evidence|queue[\s_-]?outcome|logged?)\b/)) {
    return boolResult(queueOutcomeLogged, 'requires_receipt_or_outcome_log', { value: queueOutcomeLogged, target: true });
  }

  return {
    evaluated: false,
    pass: null,
    reason: 'unsupported_metric'
  };
}

function evaluateSuccessCriteria(proposal, context, policy) {
  const src = policy && typeof policy === 'object' ? policy : {};
  const capabilityKey = src.capability_key != null
    ? src.capability_key
    : (context && context.capability_key);
  const required = src.required !== false;
  const minCount = clampInt(src.min_count, 0, 10, 1);
  const contract = capabilityMetricContract(
    capabilityKey
  );
  const enableContractBackfill = src.enable_contract_backfill !== false;
  const failOnContractViolation = src.fail_on_contract_violation === true;
  const enforceContract = contract.enforced === true && src.enforce_contract !== false;
  const enforceMinSupported = contract.enforced === true && src.enforce_min_supported !== false;
  const rowsRaw = parseSuccessCriteriaRows(proposal, {
    capability_key: capabilityKey
  });
  const backfill = enableContractBackfill
    ? backfillContractSafeRows(rowsRaw, contract, minCount)
    : { rows: rowsRaw, added_count: 0 };
  const rows = backfill.rows;
  const contractBackfillCount = Number(backfill.added_count || 0);
  const results = rows.map((row, idx) => {
    const metricNorm = String(row && row.metric || '').toLowerCase().replace(/[\s-]+/g, '_');
    const blockedByContract = enforceContract
      && !!metricNorm
      && !!(contract.allowed_metrics && !contract.allowed_metrics.has(metricNorm));
    const evald = blockedByContract
      ? {
          evaluated: false,
          pass: null,
          reason: 'metric_not_allowed_for_capability',
          capability_key: contract.capability_key,
          metric: metricNorm
        }
      : evaluateRow(row, context);
    return {
      index: idx + 1,
      source: String(row.source || ''),
      metric: String(row.metric || ''),
      target: String(row.target || '').slice(0, 180),
      evaluated: evald.evaluated === true,
      pass: evald.pass === true ? true : (evald.pass === false ? false : null),
      reason: String(evald.reason || ''),
      comparator: evald.comparator || null,
      value: evald.value == null ? null : evald.value,
      threshold: evald.target == null ? null : evald.target,
      unit: evald.unit || null
    };
  });

  const evaluatedCount = results.filter((r) => r.evaluated === true).length;
  const passedCount = results.filter((r) => r.pass === true).length;
  const failedRows = results.filter((r) => r.pass === false);
  const failedCount = failedRows.length;
  const unknownCount = results.length - evaluatedCount;
  const unsupportedCount = results.filter((r) => r.reason === 'unsupported_metric').length;
  const contractNotAllowedCount = results.filter((r) => r.reason === 'metric_not_allowed_for_capability').length;
  const structurallySupportedCount = Math.max(0, results.length - unsupportedCount - contractNotAllowedCount);
  let passed = true;
  let primaryFailure = null;

  if (required) {
    if (rows.length < minCount) {
      passed = false;
      primaryFailure = 'success_criteria_count_below_min';
    } else if (passedCount < minCount) {
      passed = false;
      primaryFailure = failedRows.length ? `success_criteria_failed:${failedRows[0].reason || 'failed'}` : 'success_criteria_pass_count_below_min';
    } else if (failedCount > 0) {
      passed = false;
      primaryFailure = `success_criteria_failed:${failedRows[0].reason || 'failed'}`;
    }
  } else if (failedCount > 0) {
    passed = false;
    primaryFailure = `success_criteria_failed:${failedRows[0].reason || 'failed'}`;
  }

  if (enforceContract && failOnContractViolation && contractNotAllowedCount > 0) {
    passed = false;
    primaryFailure = 'success_criteria_failed:metric_not_allowed_for_capability';
  } else if (enforceMinSupported && required && structurallySupportedCount < minCount) {
    passed = false;
    primaryFailure = 'success_criteria_failed:insufficient_supported_metrics';
  }

  const violationRows = results
    .filter((r) => r.reason === 'unsupported_metric' || r.reason === 'metric_not_allowed_for_capability')
    .map((r) => ({
      index: r.index,
      metric: String(r.metric || ''),
      reason: String(r.reason || '')
    }));

  return {
    required,
    min_count: minCount,
    total_count: rows.length,
    evaluated_count: evaluatedCount,
    passed_count: passedCount,
    failed_count: failedCount,
    unknown_count: unknownCount,
    unsupported_count: unsupportedCount,
    contract_not_allowed_count: contractNotAllowedCount,
    structurally_supported_count: structurallySupportedCount,
    contract_backfill_count: contractBackfillCount,
    pass_rate: evaluatedCount > 0 ? Number((passedCount / evaluatedCount).toFixed(3)) : null,
    passed,
    primary_failure: primaryFailure,
    contract: {
      capability_key: contract.capability_key || null,
      enforced: enforceContract,
      fail_on_violation: failOnContractViolation,
      min_supported_enforced: enforceMinSupported,
      backfill_enabled: enableContractBackfill,
      backfill_count: contractBackfillCount,
      allowed_metrics: contract.allowed_metrics ? Array.from(contract.allowed_metrics).sort() : [],
      unsupported_count: unsupportedCount,
      not_allowed_count: contractNotAllowedCount,
      structurally_supported_count: structurallySupportedCount,
      violation_count: violationRows.length,
      violations: violationRows.slice(0, 12)
    },
    checks: results.slice(0, 12)
  };
}

module.exports = {
  parseSuccessCriteriaRows,
  evaluateSuccessCriteria
};
