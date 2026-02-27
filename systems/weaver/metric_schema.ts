#!/usr/bin/env node
'use strict';
export {};

type AnyObj = Record<string, any>;

const COMPATIBLE_VALUE_CURRENCIES = new Set([
  'revenue',
  'delivery',
  'user_value',
  'quality',
  'time_savings',
  'learning'
]);

const BUILTIN_METRICS = [
  {
    metric_id: 'adaptive_value',
    label: 'Adaptive Value',
    unit: 'score',
    default_weight: 0.18,
    value_currency: 'user_value',
    tags: ['balanced', 'meta', 'resilience']
  },
  {
    metric_id: 'revenue',
    label: 'Revenue',
    unit: 'usd',
    default_weight: 0.16,
    value_currency: 'revenue',
    tags: ['money', 'business']
  },
  {
    metric_id: 'user_value',
    label: 'User Value',
    unit: 'score',
    default_weight: 0.18,
    value_currency: 'user_value',
    tags: ['impact', 'helpfulness']
  },
  {
    metric_id: 'quality',
    label: 'Quality',
    unit: 'score',
    default_weight: 0.16,
    value_currency: 'quality',
    tags: ['accuracy', 'stability']
  },
  {
    metric_id: 'time_savings',
    label: 'Time Savings',
    unit: 'hours',
    default_weight: 0.15,
    value_currency: 'time_savings',
    tags: ['speed', 'freedom']
  },
  {
    metric_id: 'learning',
    label: 'Learning',
    unit: 'score',
    default_weight: 0.17,
    value_currency: 'learning',
    tags: ['wisdom', 'knowledge']
  }
];

function cleanText(v: unknown, maxLen = 220) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeToken(v: unknown, maxLen = 80) {
  return cleanText(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function clampNumber(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function normalizeMetricWeight(v: unknown, fallback = 0.1) {
  return Number(clampNumber(v, 0, 1, fallback).toFixed(6));
}

function normalizeMetricId(v: unknown) {
  return normalizeToken(v, 80);
}

function normalizeUnit(v: unknown) {
  const unit = normalizeToken(v, 32) || 'score';
  return unit;
}

function normalizeTags(v: unknown) {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const row of v) {
    const token = normalizeToken(row, 40);
    if (!token || seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out.slice(0, 10);
}

function inferValueCurrency(metricId: string, label = '', tags: string[] = []) {
  const id = normalizeMetricId(metricId);
  if (!id) return 'user_value';
  if (COMPATIBLE_VALUE_CURRENCIES.has(id)) return id;
  const blob = `${id} ${normalizeToken(label, 120)} ${normalizeTags(tags).join(' ')}`;
  if (/(money|revenue|profit|cash|income|sales|usd|dollar)/.test(blob)) return 'revenue';
  if (/(quality|accuracy|truth|correct|reliable|safety)/.test(blob)) return 'quality';
  if (/(time|speed|latency|quick|freedom|efficiency)/.test(blob)) return 'time_savings';
  if (/(learn|wisdom|knowledge|insight|research|principle)/.test(blob)) return 'learning';
  if (/(deliver|shipment|execution|throughput|completion)/.test(blob)) return 'delivery';
  return 'user_value';
}

function normalizeMetricRow(raw: AnyObj, fallbackWeight = 0.1) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const metricId = normalizeMetricId(src.metric_id || src.id || src.name || '');
  if (!metricId) return null;
  const tags = normalizeTags(src.tags);
  const label = cleanText(src.label || src.name || metricId, 80) || metricId;
  const defaultWeight = normalizeMetricWeight(
    src.default_weight != null ? src.default_weight : src.weight,
    fallbackWeight
  );
  const valueCurrencyRaw = normalizeMetricId(src.value_currency || src.valueCurrency || '');
  const valueCurrency = COMPATIBLE_VALUE_CURRENCIES.has(valueCurrencyRaw)
    ? valueCurrencyRaw
    : inferValueCurrency(metricId, label, tags);
  const frozen = src.frozen === true || src.locked === true;
  return {
    metric_id: metricId,
    label,
    unit: normalizeUnit(src.unit),
    default_weight: defaultWeight,
    value_currency: valueCurrency,
    tags,
    frozen
  };
}

function parseMetricWeightPairs(raw: unknown) {
  if (raw == null) return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    const out: AnyObj = {};
    for (const [k, v] of Object.entries(raw as AnyObj)) {
      const id = normalizeMetricId(k);
      if (!id) continue;
      out[id] = normalizeMetricWeight(v, 0);
    }
    return out;
  }
  const text = String(raw || '').trim();
  if (!text) return {};
  const out: AnyObj = {};
  for (const tokenRaw of text.split(',')) {
    const token = String(tokenRaw || '').trim();
    if (!token) continue;
    const idx = token.indexOf(':');
    if (idx === -1) {
      const id = normalizeMetricId(token);
      if (!id) continue;
      out[id] = 1;
      continue;
    }
    const id = normalizeMetricId(token.slice(0, idx));
    if (!id) continue;
    out[id] = normalizeMetricWeight(token.slice(idx + 1), 0);
  }
  return out;
}

function mergeMetricRows(baseRows: AnyObj[], overlayRows: AnyObj[]) {
  const merged = new Map<string, AnyObj>();
  for (const rowRaw of baseRows || []) {
    const row = normalizeMetricRow(rowRaw, 0.1);
    if (!row) continue;
    merged.set(row.metric_id, row);
  }
  for (const rowRaw of overlayRows || []) {
    const row = normalizeMetricRow(rowRaw, 0.1);
    if (!row) continue;
    const prev = merged.get(row.metric_id);
    if (!prev) {
      merged.set(row.metric_id, row);
      continue;
    }
    merged.set(row.metric_id, {
      ...prev,
      ...row,
      tags: Array.from(new Set([...(prev.tags || []), ...(row.tags || [])])).slice(0, 10),
      default_weight: row.default_weight != null ? row.default_weight : prev.default_weight
    });
  }
  return Array.from(merged.values());
}

function normalizeAdapterRows(src: unknown) {
  const out: AnyObj[] = [];
  const adapters = Array.isArray(src) ? src : [];
  for (const adapterRaw of adapters) {
    const adapter = adapterRaw && typeof adapterRaw === 'object' ? adapterRaw : {};
    const adapterId = normalizeMetricId(adapter.id || adapter.adapter_id || adapter.name || '');
    const enabled = adapter.enabled !== false;
    if (!enabled) continue;
    const rows = Array.isArray(adapter.metrics) ? adapter.metrics : [];
    for (const rowRaw of rows) {
      const row = rowRaw && typeof rowRaw === 'object' ? rowRaw : {};
      out.push({
        ...row,
        tags: Array.from(new Set([
          ...(Array.isArray(row.tags) ? row.tags : []),
          adapterId ? `adapter:${adapterId}` : null
        ].filter(Boolean)))
      });
    }
  }
  return out;
}

function normalizePolicyMetricSchema(src: AnyObj) {
  const schema = src && typeof src === 'object' ? src : {};
  const builtinEnabled = schema.include_builtin_metrics !== false;
  const base = builtinEnabled ? BUILTIN_METRICS.slice(0) : [];
  const extras = Array.isArray(schema.extra_metrics) ? schema.extra_metrics : [];
  const rows = mergeMetricRows(base, extras);
  return {
    include_builtin_metrics: builtinEnabled,
    min_metric_weight: normalizeMetricWeight(schema.min_metric_weight, 0.04),
    default_primary_metric: normalizeMetricId(schema.default_primary_metric || 'adaptive_value') || 'adaptive_value',
    rows
  };
}

function metricRowsFromStrategy(strategy: AnyObj) {
  const valuePolicy = strategy && strategy.value_currency_policy && typeof strategy.value_currency_policy === 'object'
    ? strategy.value_currency_policy
    : {};
  const rows: AnyObj[] = [];
  const defaultCurrency = normalizeMetricId(valuePolicy.default_currency || '');
  if (defaultCurrency) {
    rows.push({
      metric_id: defaultCurrency,
      label: defaultCurrency,
      default_weight: 0.16,
      value_currency: defaultCurrency,
      tags: ['strategy_default']
    });
  }
  const currencyOverrides = valuePolicy.currency_overrides && typeof valuePolicy.currency_overrides === 'object'
    ? valuePolicy.currency_overrides
    : {};
  for (const key of Object.keys(currencyOverrides)) {
    const metricId = normalizeMetricId(key);
    if (!metricId) continue;
    rows.push({
      metric_id: metricId,
      label: metricId,
      default_weight: 0.14,
      value_currency: metricId,
      tags: ['strategy_currency']
    });
  }
  return mergeMetricRows([], rows);
}

function normalizeRequestedMetricWeights(raw: unknown) {
  return parseMetricWeightPairs(raw);
}

function buildMetricSchema(input: AnyObj = {}) {
  const policySchema = normalizePolicyMetricSchema(input.policy_metric_schema);
  const strategyRows = metricRowsFromStrategy(input.strategy || {});
  const adapterRows = normalizeAdapterRows(input.adapter_rows);
  const mergedRows = mergeMetricRows(
    mergeMetricRows(policySchema.rows, strategyRows),
    adapterRows
  );
  const requestedWeights = normalizeRequestedMetricWeights(input.requested_metrics);
  const primaryMetricHint = normalizeMetricId(input.primary_metric || policySchema.default_primary_metric || '');
  const minMetricWeight = normalizeMetricWeight(policySchema.min_metric_weight, 0.04);

  const weightedRows = mergedRows.map((rowRaw) => {
    const row = normalizeMetricRow(rowRaw, minMetricWeight);
    if (!row) return null;
    const requestedWeight = requestedWeights[row.metric_id];
    const hasRequested = Number.isFinite(Number(requestedWeight));
    const baseWeight = hasRequested
      ? normalizeMetricWeight(requestedWeight, row.default_weight)
      : normalizeMetricWeight(row.default_weight, minMetricWeight);
    const primaryBoost = primaryMetricHint && row.metric_id === primaryMetricHint ? 0.08 : 0;
    const effectiveWeight = normalizeMetricWeight(Math.max(minMetricWeight, baseWeight + primaryBoost), minMetricWeight);
    return {
      ...row,
      requested_weight: hasRequested ? normalizeMetricWeight(requestedWeight, 0) : null,
      effective_weight: effectiveWeight
    };
  }).filter(Boolean) as AnyObj[];

  const total = weightedRows.reduce((acc, row) => acc + Number(row.effective_weight || 0), 0);
  const normalized = weightedRows.map((row) => ({
    ...row,
    normalized_weight: Number(
      (total > 0 ? Number(row.effective_weight || 0) / total : 0).toFixed(6)
    )
  }));

  return {
    metrics: normalized,
    adapter_rows_count: adapterRows.length,
    requested_weights: requestedWeights,
    requested_metric_ids: Object.keys(requestedWeights),
    primary_metric_hint: primaryMetricHint || null,
    min_metric_weight: minMetricWeight
  };
}

module.exports = {
  COMPATIBLE_VALUE_CURRENCIES,
  BUILTIN_METRICS,
  normalizeMetricId,
  normalizeRequestedMetricWeights,
  inferValueCurrency,
  buildMetricSchema
};
