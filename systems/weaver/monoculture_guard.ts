#!/usr/bin/env node
'use strict';
export {};

type AnyObj = Record<string, any>;

function clampNumber(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function normalizeToken(v: unknown, maxLen = 80) {
  return String(v == null ? '' : v)
    .trim()
    .toLowerCase()
    .slice(0, maxLen)
    .replace(/[^a-z0-9_.:-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function parseTsMs(ts: unknown) {
  const ms = Date.parse(String(ts || ''));
  return Number.isFinite(ms) ? ms : null;
}

function filterRowsWithinWindow(historyRows: AnyObj[], nowTs: string, windowDays: number) {
  const nowMs = parseTsMs(nowTs) || Date.now();
  const cutoff = nowMs - (Math.max(1, Number(windowDays || 14)) * 24 * 60 * 60 * 1000);
  return historyRows.filter((row) => {
    const tsMs = parseTsMs(row && row.ts);
    return tsMs == null || tsMs >= cutoff;
  });
}

function summarizeDominance(historyRows: AnyObj[]) {
  const byMetric: AnyObj = {};
  const byCurrency: AnyObj = {};
  let total = 0;
  for (const row of historyRows) {
    const metricId = normalizeToken(row && row.primary_metric_id || '');
    const currency = normalizeToken(row && row.value_currency || '');
    if (!metricId && !currency) continue;
    total += 1;
    if (metricId) byMetric[metricId] = Number(byMetric[metricId] || 0) + 1;
    if (currency) byCurrency[currency] = Number(byCurrency[currency] || 0) + 1;
  }
  const metricSorted = Object.entries(byMetric).sort((a, b) => Number(b[1]) - Number(a[1]));
  const currencySorted = Object.entries(byCurrency).sort((a, b) => Number(b[1]) - Number(a[1]));
  const topMetric = metricSorted[0] ? String(metricSorted[0][0]) : null;
  const topCurrency = currencySorted[0] ? String(currencySorted[0][0]) : null;
  const topMetricShare = topMetric && total > 0 ? Number((Number(byMetric[topMetric]) / total).toFixed(6)) : 0;
  const topCurrencyShare = topCurrency && total > 0 ? Number((Number(byCurrency[topCurrency]) / total).toFixed(6)) : 0;
  return {
    total,
    by_metric: byMetric,
    by_currency: byCurrency,
    top_metric: topMetric,
    top_currency: topCurrency,
    top_metric_share: topMetricShare,
    top_currency_share: topCurrencyShare
  };
}

function rebalanceAwayFromDominant(rows: AnyObj[], dominantMetricId: string, maxShare: number, fallbackMetric = 'learning') {
  const metricId = normalizeToken(dominantMetricId || '');
  if (!metricId) return rows;
  const idx = rows.findIndex((row) => normalizeToken(row.metric_id || '') === metricId);
  if (idx === -1) return rows;
  const dominantShare = Number(rows[idx].share || 0);
  if (dominantShare <= maxShare) return rows;

  const out = rows.map((row) => ({ ...row, share: Number(row.share || 0) }));
  const transfer = dominantShare - maxShare;
  out[idx].share = Number(maxShare.toFixed(6));

  const receivers = out.filter((row, i) => i !== idx);
  if (!receivers.length) {
    out.push({
      metric_id: fallbackMetric,
      value_currency: fallbackMetric === 'learning' ? 'learning' : 'user_value',
      normalized_weight: 0.1,
      raw_score: 0,
      signals: {},
      share: Number(transfer.toFixed(6))
    });
  } else {
    const receiverTotal = receivers.reduce((acc, row) => acc + Math.max(Number(row.share || 0), 0.001), 0);
    for (let i = 0; i < out.length; i += 1) {
      if (i === idx) continue;
      const ratio = Math.max(Number(out[i].share || 0), 0.001) / receiverTotal;
      out[i].share = Number((Number(out[i].share || 0) + (transfer * ratio)).toFixed(6));
    }
  }

  const sum = out.reduce((acc, row) => acc + Number(row.share || 0), 0);
  return out
    .map((row) => ({
      ...row,
      share: Number((sum > 0 ? Number(row.share || 0) / sum : 0).toFixed(6))
    }))
    .sort((a, b) => Number(b.share || 0) - Number(a.share || 0));
}

function normalizeCurrencyCaps(src: unknown, defaultCap: number) {
  const out: AnyObj = {};
  const obj = src && typeof src === 'object' ? src : {};
  for (const [keyRaw, capRaw] of Object.entries(obj)) {
    const key = normalizeToken(keyRaw, 80);
    if (!key) continue;
    out[key] = clampNumber(capRaw, 0.3, 0.95, defaultCap);
  }
  return out;
}

function normalizeListTokens(src: unknown, maxItems = 32, maxLen = 80) {
  if (!Array.isArray(src)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of src) {
    const token = normalizeToken(raw, maxLen);
    if (!token || seen.has(token)) continue;
    seen.add(token);
    out.push(token);
    if (out.length >= maxItems) break;
  }
  return out;
}

function isProtectedRow(row: AnyObj, protectedMetricIds: Set<string>, protectedCurrencies: Set<string>) {
  const metricId = normalizeToken(row && row.metric_id || '', 80);
  const currency = normalizeToken(row && row.value_currency || '', 80);
  return protectedMetricIds.has(metricId) || protectedCurrencies.has(currency);
}

function enforceValueSovereignty(rows: AnyObj[], sovereignty: AnyObj = {}, fallbackMetric = 'adaptive_value') {
  if (!Array.isArray(rows) || !rows.length) {
    return {
      rows: Array.isArray(rows) ? rows : [],
      adjusted: false,
      reason_codes: [],
      sovereignty: {
        enabled: sovereignty.enabled === true,
        min_combined_share: Number(sovereignty.min_combined_share || 0),
        protected_metric_ids: Array.isArray(sovereignty.protected_metric_ids)
          ? sovereignty.protected_metric_ids.slice(0)
          : [],
        protected_value_currencies: Array.isArray(sovereignty.protected_value_currencies)
          ? sovereignty.protected_value_currencies.slice(0)
          : [],
        protected_combined_share: 0
      }
    };
  }
  if (sovereignty.enabled !== true) {
    return {
      rows,
      adjusted: false,
      reason_codes: [],
      sovereignty: {
        enabled: false,
        min_combined_share: 0,
        protected_metric_ids: [],
        protected_value_currencies: [],
        protected_combined_share: 0
      }
    };
  }

  const minCombinedShare = clampNumber(sovereignty.min_combined_share, 0.05, 0.8, 0.24);
  const protectedMetricIds = new Set(
    normalizeListTokens(sovereignty.protected_metric_ids, 32, 80)
  );
  const protectedCurrencies = new Set(
    normalizeListTokens(sovereignty.protected_value_currencies, 16, 80)
  );

  const out = rows.map((row) => ({
    ...row,
    share: clampNumber(row && row.share, 0, 1, 0)
  }));
  const protectedRows = out.filter((row) => isProtectedRow(row, protectedMetricIds, protectedCurrencies));
  let protectedCombined = protectedRows.reduce((acc, row) => acc + Number(row.share || 0), 0);
  const reasonCodes: string[] = [];

  if (!protectedRows.length) {
    const fallbackMetricId = normalizeToken(fallbackMetric || 'adaptive_value', 80) || 'adaptive_value';
    const fallbackCurrency = protectedCurrencies.has('user_value')
      ? 'user_value'
      : (Array.from(protectedCurrencies)[0] || 'user_value');
    out.push({
      metric_id: fallbackMetricId,
      value_currency: fallbackCurrency,
      normalized_weight: 0.1,
      raw_score: 0,
      signals: {},
      share: Number(minCombinedShare.toFixed(6))
    });
    reasonCodes.push('constitution_value_sovereignty_injected');
    protectedMetricIds.add(fallbackMetricId);
    protectedCombined = Math.max(protectedCombined, minCombinedShare);
  }

  if (protectedCombined < minCombinedShare) {
    const deficit = minCombinedShare - protectedCombined;
    const donors = out.filter((row) => !isProtectedRow(row, protectedMetricIds, protectedCurrencies));
    const donorTotal = donors.reduce((acc, row) => acc + Math.max(Number(row.share || 0), 0), 0);
    if (donorTotal > 0 && deficit > 0) {
      for (let i = 0; i < out.length; i += 1) {
        if (isProtectedRow(out[i], protectedMetricIds, protectedCurrencies)) continue;
        const donorShare = Math.max(Number(out[i].share || 0), 0);
        const ratio = donorShare / donorTotal;
        out[i].share = Number(Math.max(0, donorShare - (deficit * ratio)).toFixed(6));
      }
      const protectedNow = out.filter((row) => isProtectedRow(row, protectedMetricIds, protectedCurrencies));
      const protectedNowTotal = protectedNow.reduce((acc, row) => acc + Math.max(Number(row.share || 0), 0.000001), 0);
      for (let i = 0; i < out.length; i += 1) {
        if (!isProtectedRow(out[i], protectedMetricIds, protectedCurrencies)) continue;
        const base = Math.max(Number(out[i].share || 0), 0.000001);
        const ratio = base / protectedNowTotal;
        out[i].share = Number((Number(out[i].share || 0) + (deficit * ratio)).toFixed(6));
      }
      reasonCodes.push('constitution_value_sovereignty_floor_applied');
    }
  }

  const sum = out.reduce((acc, row) => acc + Number(row.share || 0), 0);
  const normalized = out
    .map((row) => ({
      ...row,
      share: Number((sum > 0 ? Number(row.share || 0) / sum : 0).toFixed(6))
    }))
    .sort((a, b) => Number(b.share || 0) - Number(a.share || 0));

  const protectedFinal = normalized
    .filter((row) => isProtectedRow(row, protectedMetricIds, protectedCurrencies))
    .reduce((acc, row) => acc + Number(row.share || 0), 0);

  return {
    rows: normalized,
    adjusted: reasonCodes.length > 0,
    reason_codes: reasonCodes,
    sovereignty: {
      enabled: true,
      min_combined_share: Number(minCombinedShare.toFixed(6)),
      protected_metric_ids: Array.from(protectedMetricIds),
      protected_value_currencies: Array.from(protectedCurrencies),
      protected_combined_share: Number(protectedFinal.toFixed(6))
    }
  };
}

function applyMonocultureGuard(input: AnyObj = {}) {
  const policy = input.policy && typeof input.policy === 'object' ? input.policy : {};
  const constitutionPolicy = input.constitution_policy && typeof input.constitution_policy === 'object'
    ? input.constitution_policy
    : {};
  const valueSovereignty = constitutionPolicy.value_sovereignty
    && typeof constitutionPolicy.value_sovereignty === 'object'
    ? constitutionPolicy.value_sovereignty
    : {};
  const enabled = policy.enabled !== false;
  const nowTs = String(input.now_ts || new Date().toISOString());
  const historyRows = Array.isArray(input.history_rows) ? input.history_rows : [];
  const rows = Array.isArray(input.rows) ? input.rows.map((row) => ({ ...row })) : [];
  const windowDays = clampNumber(policy.window_days, 1, 365, 21);
  const maxSingleMetricShare = clampNumber(policy.max_single_metric_share, 0.3, 0.95, 0.7);
  const metricCaps = normalizeCurrencyCaps(policy.metric_caps, maxSingleMetricShare);
  const currencyCaps = normalizeCurrencyCaps(policy.currency_caps, maxSingleMetricShare);

  const windowed = filterRowsWithinWindow(historyRows, nowTs, windowDays);
  const dominance = summarizeDominance(windowed);

  if (!enabled || rows.length === 0) {
    return {
      rows,
      triggered: false,
      reason_codes: [],
      dominance
    };
  }

  const currentTop = rows[0] && normalizeToken(rows[0].metric_id || '');
  const historicalDominantMetric = normalizeToken(dominance.top_metric || '');
  const historicalDominanceExceeded = dominance.top_metric_share > maxSingleMetricShare;

  let triggered = false;
  const reasonCodes: string[] = [];
  let nextRows = rows;

  if (historicalDominanceExceeded && historicalDominantMetric) {
    triggered = true;
    reasonCodes.push('historical_metric_monoculture');
    nextRows = rebalanceAwayFromDominant(nextRows, historicalDominantMetric, maxSingleMetricShare);
  }

  for (const row of nextRows.slice(0)) {
    const metricId = normalizeToken(row.metric_id || '', 80);
    const currency = normalizeToken(row.value_currency || '', 80);
    const cap = metricCaps[metricId] != null
      ? Number(metricCaps[metricId])
      : (currencyCaps[currency] != null ? Number(currencyCaps[currency]) : null);
    if (!cap) continue;
    const share = Number(row.share || 0);
    if (share <= cap) continue;
    triggered = true;
    reasonCodes.push('configured_currency_or_metric_cap');
    nextRows = rebalanceAwayFromDominant(nextRows, metricId, cap);
  }

  const sovereigntyEnforced = enforceValueSovereignty(nextRows, valueSovereignty, input.fallback_metric || 'adaptive_value');
  if (Array.isArray(sovereigntyEnforced.reason_codes) && sovereigntyEnforced.reason_codes.length) {
    triggered = true;
    reasonCodes.push(...sovereigntyEnforced.reason_codes);
  }
  nextRows = Array.isArray(sovereigntyEnforced.rows) ? sovereigntyEnforced.rows : nextRows;

  if (triggered) reasonCodes.push('rebalance_applied');

  const nextTop = nextRows[0] && normalizeToken(nextRows[0].metric_id || '');
  const topChanged = !!(currentTop && nextTop && currentTop !== nextTop);
  if (topChanged) reasonCodes.push('primary_metric_shifted');

  return {
    rows: nextRows,
    triggered,
    reason_codes: reasonCodes,
    dominance,
    top_changed: topChanged,
    sovereignty: sovereigntyEnforced.sovereignty
  };
}

module.exports = {
  applyMonocultureGuard
};
