// @ts-nocheck
'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_POLICY_PATH = process.env.EGRESS_GATEWAY_POLICY_PATH
  ? path.resolve(process.env.EGRESS_GATEWAY_POLICY_PATH)
  : path.join(REPO_ROOT, 'config', 'egress_gateway_policy.json');
const DEFAULT_STATE_PATH = process.env.EGRESS_GATEWAY_STATE_PATH
  ? path.resolve(process.env.EGRESS_GATEWAY_STATE_PATH)
  : path.join(REPO_ROOT, 'state', 'security', 'egress_state.json');
const DEFAULT_AUDIT_PATH = process.env.EGRESS_GATEWAY_AUDIT_PATH
  ? path.resolve(process.env.EGRESS_GATEWAY_AUDIT_PATH)
  : path.join(REPO_ROOT, 'state', 'security', 'egress_audit.jsonl');

class EgressGatewayError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'EgressGatewayError';
    this.details = details;
  }
}

function nowMs(input) {
  if (Number.isFinite(Number(input))) return Number(input);
  return Date.now();
}

function nowIso(ms) {
  return new Date(nowMs(ms)).toISOString();
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath, value) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}

function appendJsonl(filePath, row) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, JSON.stringify(row) + '\n', 'utf8');
}

function normalizeText(v, maxLen = 240) {
  return String(v == null ? '' : v).trim().slice(0, maxLen);
}

function normalizeScope(v) {
  return normalizeText(v, 180).toLowerCase();
}

function normalizeMethod(v) {
  return normalizeText(v || 'GET', 16).toUpperCase();
}

function clampInt(v, lo, hi, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

function normalizeDomains(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const d of raw) {
    const s = String(d || '').trim().toLowerCase();
    if (!s) continue;
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const fallback = {
    version: '1.0',
    default_decision: 'deny',
    global_rate_caps: { per_hour: 0, per_day: 0 },
    scopes: {}
  };
  const raw = readJsonSafe(policyPath, {});
  const scopes = {};
  const srcScopes = raw && raw.scopes && typeof raw.scopes === 'object' ? raw.scopes : {};
  for (const [scopeName, scopeRaw] of Object.entries(srcScopes)) {
    const scope = normalizeScope(scopeName);
    if (!scope) continue;
    const methods = Array.isArray(scopeRaw && scopeRaw.methods)
      ? Array.from(new Set(scopeRaw.methods.map(normalizeMethod).filter(Boolean)))
      : [];
    const domains = normalizeDomains(scopeRaw && scopeRaw.domains);
    const rateCaps = scopeRaw && typeof scopeRaw.rate_caps === 'object' ? scopeRaw.rate_caps : {};
    scopes[scope] = {
      methods,
      domains,
      require_runtime_allowlist: scopeRaw && scopeRaw.require_runtime_allowlist === true,
      rate_caps: {
        per_hour: clampInt(rateCaps.per_hour, 0, 10000000, 0),
        per_day: clampInt(rateCaps.per_day, 0, 10000000, 0)
      }
    };
  }
  const globalCapsRaw = raw && typeof raw.global_rate_caps === 'object' ? raw.global_rate_caps : {};
  return {
    version: normalizeText(raw.version || fallback.version, 32) || fallback.version,
    default_decision: normalizeText(raw.default_decision || fallback.default_decision, 16).toLowerCase() === 'allow' ? 'allow' : 'deny',
    global_rate_caps: {
      per_hour: clampInt(globalCapsRaw.per_hour, 0, 10000000, 0),
      per_day: clampInt(globalCapsRaw.per_day, 0, 10000000, 0)
    },
    scopes
  };
}

function loadState(statePath = DEFAULT_STATE_PATH) {
  const raw = readJsonSafe(statePath, null);
  if (!raw || typeof raw !== 'object') {
    return { version: '1.0', per_hour: {}, per_day: {} };
  }
  return {
    version: '1.0',
    per_hour: raw.per_hour && typeof raw.per_hour === 'object' ? raw.per_hour : {},
    per_day: raw.per_day && typeof raw.per_day === 'object' ? raw.per_day : {}
  };
}

function saveState(state, statePath = DEFAULT_STATE_PATH) {
  writeJsonAtomic(statePath, state);
}

function audit(entry, auditPath = DEFAULT_AUDIT_PATH) {
  appendJsonl(auditPath, {
    ts: nowIso(),
    ...(entry && typeof entry === 'object' ? entry : {})
  });
}

function pruneCounters(state) {
  const now = Date.now();
  const keepHourAfter = now - (72 * 60 * 60 * 1000);
  const keepDayAfter = now - (45 * 24 * 60 * 60 * 1000);
  for (const key of Object.keys(state.per_hour || {})) {
    const ts = Date.parse(`${key}:00:00.000Z`);
    if (!Number.isFinite(ts) || ts < keepHourAfter) delete state.per_hour[key];
  }
  for (const key of Object.keys(state.per_day || {})) {
    const ts = Date.parse(`${key}T00:00:00.000Z`);
    if (!Number.isFinite(ts) || ts < keepDayAfter) delete state.per_day[key];
  }
}

function getCounterBucket(container, key) {
  if (!container[key] || typeof container[key] !== 'object') {
    container[key] = { total: 0, scopes: {} };
  }
  if (!container[key].scopes || typeof container[key].scopes !== 'object') {
    container[key].scopes = {};
  }
  container[key].total = Number(container[key].total || 0);
  return container[key];
}

function periodKeys(ms) {
  const iso = nowIso(ms);
  return {
    day: iso.slice(0, 10),
    hour: iso.slice(0, 13)
  };
}

function domainAllowed(domain, patterns) {
  const d = normalizeText(domain, 255).toLowerCase();
  if (!d) return false;
  for (const raw of patterns || []) {
    const p = normalizeText(raw, 255).toLowerCase();
    if (!p) continue;
    if (p === '*' || p === '*.*') return true;
    if (p.startsWith('*.')) {
      const base = p.slice(2);
      if (!base) continue;
      if (d === base || d.endsWith(`.${base}`)) return true;
      continue;
    }
    if (d === p || d.endsWith(`.${p}`)) return true;
  }
  return false;
}

function authorizeEgress(opts = {}) {
  const scope = normalizeScope(opts.scope || '');
  const caller = normalizeText(opts.caller || 'unknown', 180);
  const method = normalizeMethod(opts.method || 'GET');
  const apply = opts.apply !== false;
  const runtimeAllowlist = normalizeDomains(opts.runtime_allowlist);
  const meta = opts.meta && typeof opts.meta === 'object' ? opts.meta : {};
  const atMs = nowMs(opts.now_ms);

  const policy = loadPolicy(opts.policy_path || DEFAULT_POLICY_PATH);
  const state = loadState(opts.state_path || DEFAULT_STATE_PATH);
  pruneCounters(state);

  const out = {
    ok: false,
    allow: false,
    decision: 'deny',
    reason: 'unknown',
    scope,
    caller,
    method,
    host: null,
    path: null,
    apply
  };

  if (!scope) {
    out.reason = 'scope_required';
    audit({ type: 'egress_decision', ...out, meta }, opts.audit_path || DEFAULT_AUDIT_PATH);
    return out;
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(String(opts.url || ''));
  } catch {
    out.reason = 'url_invalid';
    audit({ type: 'egress_decision', ...out, meta }, opts.audit_path || DEFAULT_AUDIT_PATH);
    return out;
  }

  const protocol = normalizeText(parsedUrl.protocol || '', 16).toLowerCase();
  if (protocol !== 'https:' && protocol !== 'http:') {
    out.reason = 'protocol_not_allowed';
    out.host = parsedUrl.hostname || null;
    out.path = parsedUrl.pathname || null;
    audit({ type: 'egress_decision', ...out, meta }, opts.audit_path || DEFAULT_AUDIT_PATH);
    return out;
  }

  out.host = normalizeText(parsedUrl.hostname || '', 255).toLowerCase() || null;
  out.path = normalizeText(parsedUrl.pathname || '', 512) || null;

  let rule = policy.scopes[scope] || null;
  if (!rule && scope.startsWith('sensory.collector.')) {
    rule = policy.scopes['sensory.collector.dynamic'] || null;
  }
  if (!rule) {
    if (policy.default_decision !== 'allow') {
      out.reason = 'scope_not_configured';
      audit({ type: 'egress_decision', ...out, meta }, opts.audit_path || DEFAULT_AUDIT_PATH);
      return out;
    }
  }

  const allowedMethods = rule ? rule.methods : [];
  if (allowedMethods && allowedMethods.length > 0 && !allowedMethods.includes(method)) {
    out.reason = 'method_not_allowlisted';
    audit({ type: 'egress_decision', ...out, meta }, opts.audit_path || DEFAULT_AUDIT_PATH);
    return out;
  }

  const requireRuntimeAllowlist = Boolean(rule && rule.require_runtime_allowlist === true);
  if (requireRuntimeAllowlist && runtimeAllowlist.length === 0) {
    out.reason = 'runtime_allowlist_required';
    audit({ type: 'egress_decision', ...out, meta }, opts.audit_path || DEFAULT_AUDIT_PATH);
    return out;
  }

  const domainPatterns = [
    ...(rule && Array.isArray(rule.domains) ? rule.domains : []),
    ...runtimeAllowlist
  ];
  if (!domainAllowed(out.host, domainPatterns)) {
    out.reason = 'domain_not_allowlisted';
    audit({ type: 'egress_decision', ...out, runtime_allowlist_count: runtimeAllowlist.length, meta }, opts.audit_path || DEFAULT_AUDIT_PATH);
    return out;
  }

  const keys = periodKeys(atMs);
  const dayBucket = getCounterBucket(state.per_day, keys.day);
  const hourBucket = getCounterBucket(state.per_hour, keys.hour);
  const dayScopeCount = Number(dayBucket.scopes[scope] || 0);
  const hourScopeCount = Number(hourBucket.scopes[scope] || 0);

  const scopeCaps = rule && rule.rate_caps ? rule.rate_caps : { per_hour: 0, per_day: 0 };
  const globalCaps = policy.global_rate_caps || { per_hour: 0, per_day: 0 };

  if (Number(scopeCaps.per_hour || 0) > 0 && (hourScopeCount + 1) > Number(scopeCaps.per_hour)) {
    out.reason = 'scope_hour_cap_exceeded';
    audit({ type: 'egress_decision', ...out, counters: { hour_scope_count: hourScopeCount, hour_scope_cap: Number(scopeCaps.per_hour || 0) }, meta }, opts.audit_path || DEFAULT_AUDIT_PATH);
    return out;
  }
  if (Number(scopeCaps.per_day || 0) > 0 && (dayScopeCount + 1) > Number(scopeCaps.per_day)) {
    out.reason = 'scope_day_cap_exceeded';
    audit({ type: 'egress_decision', ...out, counters: { day_scope_count: dayScopeCount, day_scope_cap: Number(scopeCaps.per_day || 0) }, meta }, opts.audit_path || DEFAULT_AUDIT_PATH);
    return out;
  }
  if (Number(globalCaps.per_hour || 0) > 0 && (Number(hourBucket.total || 0) + 1) > Number(globalCaps.per_hour)) {
    out.reason = 'global_hour_cap_exceeded';
    audit({ type: 'egress_decision', ...out, counters: { hour_total: Number(hourBucket.total || 0), hour_global_cap: Number(globalCaps.per_hour || 0) }, meta }, opts.audit_path || DEFAULT_AUDIT_PATH);
    return out;
  }
  if (Number(globalCaps.per_day || 0) > 0 && (Number(dayBucket.total || 0) + 1) > Number(globalCaps.per_day)) {
    out.reason = 'global_day_cap_exceeded';
    audit({ type: 'egress_decision', ...out, counters: { day_total: Number(dayBucket.total || 0), day_global_cap: Number(globalCaps.per_day || 0) }, meta }, opts.audit_path || DEFAULT_AUDIT_PATH);
    return out;
  }

  out.ok = true;
  out.allow = true;
  out.decision = 'allow';
  out.reason = 'allowlisted';

  if (apply) {
    dayBucket.total = Number(dayBucket.total || 0) + 1;
    dayBucket.scopes[scope] = Number(dayBucket.scopes[scope] || 0) + 1;
    hourBucket.total = Number(hourBucket.total || 0) + 1;
    hourBucket.scopes[scope] = Number(hourBucket.scopes[scope] || 0) + 1;
    saveState(state, opts.state_path || DEFAULT_STATE_PATH);
  }

  audit({
    type: 'egress_decision',
    ...out,
    counters: {
      day_scope_count: dayBucket.scopes[scope],
      hour_scope_count: hourBucket.scopes[scope],
      day_total: dayBucket.total,
      hour_total: hourBucket.total
    },
    meta
  }, opts.audit_path || DEFAULT_AUDIT_PATH);

  return out;
}

async function egressFetch(url, fetchOptions = {}, gateOptions = {}) {
  const method = normalizeMethod(fetchOptions.method || gateOptions.method || 'GET');
  const decision = authorizeEgress({
    scope: gateOptions.scope,
    caller: gateOptions.caller,
    method,
    url,
    apply: gateOptions.apply !== false,
    runtime_allowlist: gateOptions.runtime_allowlist,
    policy_path: gateOptions.policy_path,
    state_path: gateOptions.state_path,
    audit_path: gateOptions.audit_path,
    meta: gateOptions.meta,
    now_ms: gateOptions.now_ms
  });

  if (!decision.allow) {
    throw new EgressGatewayError(`egress denied: ${decision.reason}`, {
      code: decision.reason,
      decision
    });
  }

  const timeoutMs = clampInt(gateOptions.timeout_ms, 100, 120000, 10000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...fetchOptions,
      method,
      signal: controller.signal
    });
    res.__egress_decision = decision;
    return res;
  } catch (err) {
    audit({
      type: 'egress_fetch_error',
      scope: decision.scope,
      caller: decision.caller,
      method,
      host: decision.host,
      path: decision.path,
      reason: normalizeText(err && err.message ? err.message : err || 'fetch_failed', 240)
    }, gateOptions.audit_path || DEFAULT_AUDIT_PATH);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function egressFetchText(url, fetchOptions = {}, gateOptions = {}) {
  const res = await egressFetch(url, fetchOptions, gateOptions);
  const text = await res.text();
  return {
    ok: res.ok,
    status: Number(res.status || 0),
    text,
    headers: res.headers,
    decision: res.__egress_decision || null
  };
}

module.exports = {
  EgressGatewayError,
  DEFAULT_POLICY_PATH,
  DEFAULT_STATE_PATH,
  DEFAULT_AUDIT_PATH,
  loadPolicy,
  loadState,
  authorizeEgress,
  egressFetch,
  egressFetchText
};
