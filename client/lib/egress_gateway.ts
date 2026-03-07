#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');
const {
  ROOT,
  nowIso,
  cleanText,
  normalizeToken,
  readJson,
  writeJsonAtomic,
  appendJsonl,
  resolvePath
} = require('./queued_backlog_runtime');

type AnyObj = Record<string, any>;

const DEFAULT_POLICY_REL = 'config/egress_gateway_policy.json';
const DEFAULT_STATE_REL = 'state/security/egress_gateway/state.json';
const DEFAULT_AUDIT_REL = 'state/security/egress_gateway/audit.jsonl';

class EgressGatewayError extends Error {
  decision: AnyObj;
  constructor(message: string, decision: AnyObj) {
    super(message);
    this.name = 'EgressGatewayError';
    this.decision = decision;
  }
}

function policyPath() {
  const raw = cleanText(process.env.EGRESS_GATEWAY_POLICY_PATH || '', 520);
  return resolvePath(raw, DEFAULT_POLICY_REL);
}

function statePath() {
  const raw = cleanText(process.env.EGRESS_GATEWAY_STATE_PATH || '', 520);
  return resolvePath(raw, DEFAULT_STATE_REL);
}

function auditPath() {
  const raw = cleanText(process.env.EGRESS_GATEWAY_AUDIT_PATH || '', 520);
  return resolvePath(raw, DEFAULT_AUDIT_REL);
}

function parseHost(rawUrl: unknown) {
  try {
    return new URL(String(rawUrl || '')).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function domainMatches(host: string, domain: string) {
  const needle = String(domain || '').trim().toLowerCase();
  if (!needle) return false;
  return host === needle || host.endsWith(`.${needle}`);
}

function normalizeScopeRule(id: string, rawRule: AnyObj) {
  const methods = Array.isArray(rawRule && rawRule.methods)
    ? rawRule.methods.map((row: unknown) => normalizeToken(row, 20).toUpperCase()).filter(Boolean)
    : ['GET'];
  const domains = Array.isArray(rawRule && rawRule.domains)
    ? rawRule.domains.map((row: unknown) => cleanText(row, 160).toLowerCase()).filter(Boolean)
    : [];
  return {
    id: normalizeToken(id, 120),
    methods,
    domains,
    require_runtime_allowlist: rawRule && rawRule.require_runtime_allowlist === true,
    rate_caps: {
      per_hour: Number(rawRule && rawRule.rate_caps && rawRule.rate_caps.per_hour) || null,
      per_day: Number(rawRule && rawRule.rate_caps && rawRule.rate_caps.per_day) || null
    }
  };
}

function loadPolicy() {
  const src = readJson(policyPath(), {});
  const scopesRaw = src.scopes && typeof src.scopes === 'object' ? src.scopes : {};
  const scopes: AnyObj = {};
  for (const [id, row] of Object.entries(scopesRaw)) {
    const norm = normalizeScopeRule(id, row as AnyObj);
    if (norm.id) scopes[norm.id] = norm;
  }
  return {
    version: cleanText(src.version || '1.0', 32) || '1.0',
    default_decision: normalizeToken(src.default_decision || 'deny', 10) || 'deny',
    global_rate_caps: {
      per_hour: Number(src.global_rate_caps && src.global_rate_caps.per_hour) || null,
      per_day: Number(src.global_rate_caps && src.global_rate_caps.per_day) || null
    },
    scopes
  };
}

function loadState() {
  const src = readJson(statePath(), {});
  return {
    schema_id: 'egress_gateway_state',
    schema_version: '1.0',
    updated_at: cleanText(src.updated_at || '', 80) || null,
    per_hour: src.per_hour && typeof src.per_hour === 'object' ? src.per_hour : {},
    per_day: src.per_day && typeof src.per_day === 'object' ? src.per_day : {}
  };
}

function writeState(next: AnyObj) {
  writeJsonAtomic(statePath(), next);
}

function resolveScopeRule(policy: AnyObj, scopeId: string) {
  if (policy.scopes[scopeId]) return policy.scopes[scopeId];
  if (scopeId.startsWith('sensory.collector.') && policy.scopes['sensory.collector.dynamic']) {
    return policy.scopes['sensory.collector.dynamic'];
  }
  return null;
}

function countKey(scopeId: string, epochKey: string) {
  return `${scopeId}:${epochKey}`;
}

function incrementCounter(bucket: AnyObj, key: string) {
  bucket[key] = Number(bucket[key] || 0) + 1;
}

function checkCap(bucket: AnyObj, key: string, cap: number | null) {
  if (!(Number(cap) > 0)) return { ok: true };
  return { ok: Number(bucket[key] || 0) < Number(cap) };
}

function authorizeEgress(input: AnyObj) {
  const policy = loadPolicy();
  const scopeId = normalizeToken(input.scope || '', 160);
  const method = normalizeToken(input.method || 'GET', 20).toUpperCase();
  const caller = normalizeToken(input.caller || 'unknown', 120) || 'unknown';
  const url = cleanText(input.url || '', 2000);
  const host = parseHost(url);
  const runtimeAllowlist = Array.isArray(input.runtime_allowlist)
    ? input.runtime_allowlist.map((row: unknown) => cleanText(row, 160).toLowerCase()).filter(Boolean)
    : [];
  const nowMs = Number(input.now_ms) > 0 ? Number(input.now_ms) : Date.now();
  const ts = new Date(nowMs).toISOString();
  const hourKey = new Date(nowMs).toISOString().slice(0, 13);
  const dayKey = new Date(nowMs).toISOString().slice(0, 10);
  const apply = input.apply !== false;

  const state = loadState();
  const rule = resolveScopeRule(policy, scopeId);

  const out: AnyObj = {
    ok: true,
    type: 'egress_gateway_decision',
    ts,
    scope: scopeId,
    caller,
    method,
    url,
    host,
    allow: false,
    reason: 'unknown'
  };

  if (!rule) {
    out.allow = policy.default_decision === 'allow';
    out.reason = out.allow ? 'default_allow' : 'scope_not_allowlisted';
    return out;
  }

  if (!rule.methods.includes(method)) {
    out.reason = 'method_not_allowlisted';
    return out;
  }

  if (!host) {
    out.reason = 'invalid_url';
    return out;
  }

  if (rule.domains.length > 0 && !rule.domains.some((d: string) => domainMatches(host, d))) {
    out.reason = 'domain_not_allowlisted';
    return out;
  }

  if (rule.require_runtime_allowlist) {
    if (!runtimeAllowlist.length) {
      out.reason = 'runtime_allowlist_required';
      return out;
    }
    const runtimeAllowed = runtimeAllowlist.some((d: string) => domainMatches(host, d));
    if (!runtimeAllowed) {
      out.reason = 'runtime_allowlist_blocked';
      return out;
    }
  }

  const scopeHourKey = countKey(scopeId, hourKey);
  const scopeDayKey = countKey(scopeId, dayKey);
  const globalHourKey = countKey('__global__', hourKey);
  const globalDayKey = countKey('__global__', dayKey);

  const scopeHourCap = checkCap(state.per_hour, scopeHourKey, rule.rate_caps.per_hour);
  if (!scopeHourCap.ok) {
    out.reason = 'scope_hour_cap_exceeded';
    return out;
  }
  const scopeDayCap = checkCap(state.per_day, scopeDayKey, rule.rate_caps.per_day);
  if (!scopeDayCap.ok) {
    out.reason = 'scope_day_cap_exceeded';
    return out;
  }
  const globalHourCap = checkCap(state.per_hour, globalHourKey, policy.global_rate_caps.per_hour);
  if (!globalHourCap.ok) {
    out.reason = 'global_hour_cap_exceeded';
    return out;
  }
  const globalDayCap = checkCap(state.per_day, globalDayKey, policy.global_rate_caps.per_day);
  if (!globalDayCap.ok) {
    out.reason = 'global_day_cap_exceeded';
    return out;
  }

  out.allow = true;
  out.reason = 'ok';
  out.scope_resolved = rule.id;

  if (apply) {
    incrementCounter(state.per_hour, scopeHourKey);
    incrementCounter(state.per_day, scopeDayKey);
    incrementCounter(state.per_hour, globalHourKey);
    incrementCounter(state.per_day, globalDayKey);
    state.updated_at = ts;
    writeState(state);
    appendJsonl(auditPath(), out);
  }

  return out;
}

async function egressFetch(url: string, init: AnyObj = {}, context: AnyObj = {}) {
  const decision = authorizeEgress({
    scope: context.scope,
    caller: context.caller,
    runtime_allowlist: context.runtime_allowlist,
    now_ms: context.now_ms,
    apply: context.apply !== false,
    url,
    method: normalizeToken(init.method || 'GET', 20).toUpperCase()
  });
  if (!decision.allow) {
    throw new EgressGatewayError(`egress_denied:${decision.reason}`, decision);
  }
  return fetch(url, init);
}

module.exports = {
  EgressGatewayError,
  authorizeEgress,
  egressFetch,
  loadPolicy,
  loadState
};
