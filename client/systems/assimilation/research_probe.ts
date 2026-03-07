#!/usr/bin/env node
'use strict';
export {};

type AnyObj = Record<string, any>;

function cleanText(v: unknown, maxLen = 220) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeToken(v: unknown, maxLen = 80) {
  return cleanText(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.:/-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function clampInt(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

function clampNumber(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function normalizeStringList(src: unknown, maxItems = 64, maxLen = 220) {
  if (!Array.isArray(src)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of src) {
    const text = cleanText(raw, maxLen);
    if (!text) continue;
    if (seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= maxItems) break;
  }
  return out;
}

function runResearchProbe(input: AnyObj = {}, policy: AnyObj = {}) {
  const capabilityId = normalizeToken(input.capability_id || '', 160) || 'unknown_capability';
  const sourceType = normalizeToken(input.source_type || '', 64) || 'external_tool';
  const legal = input.legal && typeof input.legal === 'object' ? input.legal : {};
  const metadata = input.metadata && typeof input.metadata === 'object' ? input.metadata : {};
  const profile = policy && policy.research_probe && typeof policy.research_probe === 'object'
    ? policy.research_probe
    : {};
  const minConfidence = clampNumber(profile.min_confidence, 0, 1, 0.55);

  const apiEndpoints = normalizeStringList(metadata.api_endpoints, 256, 280);
  const docsUrls = normalizeStringList(metadata.docs_urls, 64, 300);
  const edgeCases = normalizeStringList(metadata.edge_cases, 64, 180);
  const authModel = normalizeToken(metadata.auth_model || legal.auth_model || '', 80) || 'unknown';
  const rateLimits = normalizeStringList(metadata.rate_limits, 64, 140);
  const legalSurface = {
    license: normalizeToken(legal.license || '', 80) || null,
    tos_ok: legal.tos_ok === true,
    robots_ok: legal.robots_ok === true,
    data_rights_ok: legal.data_rights_ok === true
  };

  let confidence = 0.25;
  if (docsUrls.length > 0) confidence += 0.18;
  if (apiEndpoints.length > 0) confidence += 0.2;
  if (authModel !== 'unknown') confidence += 0.12;
  if (rateLimits.length > 0) confidence += 0.1;
  if (edgeCases.length > 0) confidence += 0.1;
  if (legalSurface.license) confidence += 0.05;
  if (legalSurface.tos_ok) confidence += 0.05;
  if (legalSurface.robots_ok) confidence += 0.05;
  if (legalSurface.data_rights_ok) confidence += 0.05;
  confidence = Number(clampNumber(confidence, 0, 1, 0).toFixed(6));

  const reasonCodes: string[] = ['research_probe_completed'];
  if (docsUrls.length === 0) reasonCodes.push('research_docs_missing');
  if (apiEndpoints.length === 0 && sourceType !== 'local_skill') reasonCodes.push('research_api_surface_sparse');
  if (authModel === 'unknown') reasonCodes.push('research_auth_unknown');
  if (rateLimits.length === 0) reasonCodes.push('research_rate_limits_unknown');
  if (confidence < minConfidence) reasonCodes.push('research_confidence_below_threshold');

  const fit = confidence >= minConfidence ? 'sufficient' : 'insufficient';
  return {
    capability_id: capabilityId,
    source_type: sourceType,
    confidence,
    fit,
    min_confidence: minConfidence,
    reason_codes: reasonCodes,
    properties: {
      api_endpoints_count: clampInt(apiEndpoints.length, 0, 100000, 0),
      docs_urls_count: clampInt(docsUrls.length, 0, 100000, 0),
      edge_cases_count: clampInt(edgeCases.length, 0, 100000, 0),
      auth_model: authModel,
      rate_limits_count: clampInt(rateLimits.length, 0, 100000, 0)
    },
    artifacts: {
      docs_urls: docsUrls.slice(0, 32),
      sample_api_endpoints: apiEndpoints.slice(0, 32),
      sample_edge_cases: edgeCases.slice(0, 32),
      rate_limits: rateLimits.slice(0, 32)
    },
    legal_surface: legalSurface
  };
}

module.exports = {
  runResearchProbe
};
