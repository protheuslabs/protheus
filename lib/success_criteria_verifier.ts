// @ts-nocheck
'use strict';

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

function parseSuccessCriteriaRows(proposal) {
  const p = proposal && typeof proposal === 'object' ? proposal : {};
  const actionSpec = p.action_spec && typeof p.action_spec === 'object' ? p.action_spec : {};
  const actionRows = Array.isArray(actionSpec.success_criteria) ? actionSpec.success_criteria : [];
  const verifyRows = Array.isArray(actionSpec.verify) ? actionSpec.verify : [];
  const validationRows = Array.isArray(p.validation) ? p.validation : [];
  const rows = [];

  const pushRow = (value, source) => {
    if (typeof value === 'string') {
      const text = normalizeSpaces(value);
      if (!text) return;
      rows.push({
        source,
        metric: '',
        target: text
      });
      return;
    }
    if (!value || typeof value !== 'object') return;
    const metric = normalizeSpaces(value.metric || value.name || '');
    const target = normalizeSpaces(value.target || value.threshold || value.description || value.goal || '');
    const horizon = normalizeSpaces(value.horizon || value.window || value.by || '');
    const merged = normalizeSpaces([metric, target, horizon].filter(Boolean).join(' | '));
    if (!merged) return;
    rows.push({
      source,
      metric: metric.toLowerCase(),
      target: merged
    });
  };

  for (const row of actionRows) pushRow(row, 'action_spec.success_criteria');
  for (const row of verifyRows) pushRow(row, 'action_spec.verify');
  for (const row of validationRows) pushRow(row, 'validation');

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
  const rows = parseSuccessCriteriaRows(proposal);
  const src = policy && typeof policy === 'object' ? policy : {};
  const required = src.required !== false;
  const minCount = clampInt(src.min_count, 0, 10, 1);
  const results = rows.map((row, idx) => {
    const evald = evaluateRow(row, context);
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

  return {
    required,
    min_count: minCount,
    total_count: rows.length,
    evaluated_count: evaluatedCount,
    passed_count: passedCount,
    failed_count: failedCount,
    unknown_count: unknownCount,
    pass_rate: evaluatedCount > 0 ? Number((passedCount / evaluatedCount).toFixed(3)) : null,
    passed,
    primary_failure: primaryFailure,
    checks: results.slice(0, 12)
  };
}

module.exports = {
  parseSuccessCriteriaRows,
  evaluateSuccessCriteria
};
