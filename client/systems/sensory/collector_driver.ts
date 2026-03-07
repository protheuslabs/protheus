#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');
const ts = require('typescript');

const WORKSPACE_DIR = path.join(__dirname, '..', '..');
const ADAPTIVE_COLLECTOR_DIR = process.env.ADAPTIVE_EYES_COLLECTOR_DIR
  ? path.resolve(process.env.ADAPTIVE_EYES_COLLECTOR_DIR)
  : path.join(WORKSPACE_DIR, 'adaptive', 'sensory', 'eyes', 'collectors');
const COLLECTOR_DRIVER_MAX_ATTEMPTS = Math.max(1, Number(process.env.COLLECTOR_DRIVER_MAX_ATTEMPTS || 2));
const COLLECTOR_DRIVER_RETRY_BACKOFF_MS = Math.max(50, Number(process.env.COLLECTOR_DRIVER_RETRY_BACKOFF_MS || 200));
const COLLECTOR_DRIVER_MAX_TIMEOUT_MS = Math.max(1000, Number(process.env.COLLECTOR_DRIVER_MAX_TIMEOUT_MS || 60000));

function normalizeKey(v) {
  return String(v || '').trim().toLowerCase();
}

function collectorModulePath(parserType) {
  const key = normalizeKey(parserType).replace(/[^a-z0-9_\-]/g, '_');
  if (!key) return null;
  const jsPath = path.join(ADAPTIVE_COLLECTOR_DIR, `${key}.js`);
  if (fs.existsSync(jsPath)) return jsPath;
  const tsPath = path.join(ADAPTIVE_COLLECTOR_DIR, `${key}.ts`);
  if (fs.existsSync(tsPath)) return tsPath;
  return jsPath;
}

function hasCollector(parserType) {
  const modulePath = collectorModulePath(parserType);
  return !!(modulePath && fs.existsSync(modulePath));
}

function listCollectors() {
  if (!fs.existsSync(ADAPTIVE_COLLECTOR_DIR)) return [];
  return fs.readdirSync(ADAPTIVE_COLLECTOR_DIR)
    .filter((f) => f.endsWith('.js') || f.endsWith('.ts'))
    .map((f) => f.replace(/\.(js|ts)$/i, ''))
    .filter((value, idx, arr) => arr.indexOf(value) === idx)
    .sort((a, b) => a.localeCompare(b));
}

function loadTsModule(modulePath) {
  const source = fs.readFileSync(modulePath, 'utf8');
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
      esModuleInterop: true,
      allowSyntheticDefaultImports: true,
      sourceMap: false,
      declaration: false,
      removeComments: false
    },
    fileName: modulePath,
    reportDiagnostics: false
  }).outputText;
  const m = new Module(modulePath, module.parent || module);
  m.filename = modulePath;
  m.paths = Module._nodeModulePaths(path.dirname(modulePath));
  m._compile(transpiled, modulePath);
  return m.exports;
}

function loadCollectorModule(parserType) {
  const modulePath = collectorModulePath(parserType);
  if (!modulePath || !fs.existsSync(modulePath)) {
    return { ok: false, error: 'collector_module_missing', parser_type: normalizeKey(parserType), module_path: modulePath };
  }
  try {
    let mod = null;
    if (modulePath.endsWith('.ts')) {
      mod = loadTsModule(modulePath);
    } else {
      // Clear cache so adaptive updates are picked up in long-running processes.
      delete require.cache[require.resolve(modulePath)];
      mod = require(modulePath);
    }
    if (!mod || typeof mod !== 'object') {
      return { ok: false, error: 'collector_module_invalid', parser_type: normalizeKey(parserType), module_path: modulePath };
    }
    return { ok: true, parser_type: normalizeKey(parserType), module_path: modulePath, module: mod };
  } catch (err) {
    return {
      ok: false,
      error: 'collector_module_load_failed',
      parser_type: normalizeKey(parserType),
      module_path: modulePath,
      message: String(err && err.message ? err.message : err || 'load_failed').slice(0, 240)
    };
  }
}

function findFn(mod, preferred = [], prefixes = []) {
  for (const name of preferred) {
    if (name && typeof mod[name] === 'function') return { name, fn: mod[name] };
  }
  const keys = Object.keys(mod || {});
  for (const key of keys) {
    const lower = String(key || '').toLowerCase();
    if (!prefixes.some((p) => lower.startsWith(String(p || '').toLowerCase()))) continue;
    if (typeof mod[key] === 'function') return { name: key, fn: mod[key] };
  }
  return null;
}

function runOptions(eyeConfig, budgets) {
  const opts = {
    ...(eyeConfig && typeof eyeConfig.parser_options === 'object' ? eyeConfig.parser_options : {}),
    maxItems: Number(budgets && budgets.max_items) || Number(budgets && budgets.maxItems) || 10,
    maxItemsPerQuery: Number(budgets && budgets.max_items) || 10,
    minHours: 0,
    force: true
  };
  const sec = Number(budgets && budgets.max_seconds);
  if (Number.isFinite(sec) && sec > 0) opts.timeoutMs = Math.round(sec * 1000);
  return opts;
}

function waitMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function withTimeout(promise, timeoutMs) {
  const ms = Math.max(500, Number(timeoutMs) || 5000);
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`collector_timeout_${ms}ms`));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function collectRetryableCode(code) {
  const c = String(code || '').trim().toLowerCase();
  return (
    c === 'timeout'
    || c === 'network_error'
    || c === 'dns_unreachable'
    || c === 'connection_refused'
    || c === 'connection_reset'
    || c === 'tls_error'
    || c === 'http_5xx'
    || c === 'rate_limited'
    || c === 'collector_error'
  );
}

function isRetryableCollectResult(out) {
  const code = String(out && out.error_code || '').trim().toLowerCase();
  if (collectRetryableCode(code)) return true;
  const msg = String(out && out.error || '').toLowerCase();
  return (
    msg.includes('timeout')
    || msg.includes('network')
    || msg.includes('dns')
    || msg.includes('connection')
    || msg.includes('tls')
  );
}

async function callCollect(f, eyeConfig, budgets) {
  const name = String(f && f.name || '').toLowerCase();
  if (name === 'run') return f.fn(runOptions(eyeConfig, budgets));
  if (name === 'collect') {
    try {
      return await f.fn({ eyeConfig, budgets, options: runOptions(eyeConfig, budgets) });
    } catch {
      return f.fn(eyeConfig, budgets);
    }
  }
  if (name.startsWith('collect')) {
    return f.fn(eyeConfig, budgets);
  }
  return f.fn(runOptions(eyeConfig, budgets));
}

async function callPreflight(f, eyeConfig, budgets) {
  const name = String(f && f.name || '').toLowerCase();
  if (name === 'preflight') {
    try {
      return await f.fn({ eyeConfig, budgets, options: runOptions(eyeConfig, budgets) });
    } catch {
      return f.fn(eyeConfig, budgets);
    }
  }
  if (name.startsWith('preflight')) {
    if (f.fn.length === 0) return f.fn();
    return f.fn(eyeConfig, budgets);
  }
  if (f.fn.length === 0) return f.fn();
  return f.fn(eyeConfig, budgets);
}

function toNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function normalizePreflightResult(result, parserType) {
  const raw = result && typeof result === 'object' ? result : {};
  const checks = Array.isArray(raw.checks) ? [...raw.checks] : [];
  if (!Array.isArray(raw.checks)) {
    if (typeof raw.reachable === 'boolean') checks.push({ name: 'reachable', ok: raw.reachable });
    if (typeof raw.authenticated === 'boolean') checks.push({ name: 'authenticated', ok: raw.authenticated });
    if (Number.isFinite(Number(raw.items_sample))) checks.push({ name: 'items_sample', ok: Number(raw.items_sample) >= 0, value: Number(raw.items_sample) });
  }

  let failures = Array.isArray(raw.failures) ? [...raw.failures] : [];
  const ok = raw.ok === true;
  if (!ok && failures.length === 0) {
    const code = String(raw.error_code || raw.code || raw.error || 'preflight_failed').trim().toLowerCase() || 'preflight_failed';
    const message = String(raw.message || raw.error_message || raw.error || `preflight failed (${code})`).slice(0, 200);
    const httpStatus = Number(raw.http_status);
    failures = [{
      code,
      message,
      ...(Number.isFinite(httpStatus) && httpStatus > 0 ? { http_status: httpStatus } : {})
    }];
  }

  return {
    ok,
    parser_type: raw.parser_type || parserType,
    checks,
    failures
  };
}

function normalizeCollectResult(result) {
  const raw = result && typeof result === 'object' ? result : {};
  const items = Array.isArray(raw.items) ? raw.items : [];
  const ok = raw.success === true || raw.ok === true;
  return {
    ok,
    success: ok,
    items,
    bytes: toNumber(raw.bytes, 0),
    duration_ms: toNumber(raw.duration_ms, 0),
    requests: toNumber(raw.requests, 0),
    error: raw.error || null,
    error_code: raw.error_code || null,
    error_http_status: Number.isFinite(Number(raw.error_http_status))
      ? Number(raw.error_http_status)
      : null,
    degraded: raw.degraded === true,
    cache_hit: raw.cache_hit === true
  };
}

async function collectWithDriver(eyeConfig) {
  const parserType = normalizeKey(eyeConfig && eyeConfig.parser_type);
  const budgets = eyeConfig && eyeConfig.budgets ? eyeConfig.budgets : {};
  const loaded = loadCollectorModule(parserType);
  if (!loaded.ok) {
    return {
      ok: false,
      success: false,
      items: [],
      bytes: 0,
      duration_ms: 0,
      requests: 0,
      error: loaded.error || 'collector_module_missing',
      error_code: loaded.error || 'collector_module_missing',
      error_http_status: null
    };
  }

  const collectFn = findFn(loaded.module, ['collect', 'run'], ['collect']);
  if (!collectFn) {
    return {
      ok: false,
      success: false,
      items: [],
      bytes: 0,
      duration_ms: 0,
      requests: 0,
      error: 'collector_collect_fn_missing',
      error_code: 'collector_collect_fn_missing',
      error_http_status: null
    };
  }

  const budgetTimeoutMs = Number(budgets && budgets.max_seconds) > 0
    ? Math.max(500, Math.min(COLLECTOR_DRIVER_MAX_TIMEOUT_MS, Math.round(Number(budgets.max_seconds) * 1000)))
    : COLLECTOR_DRIVER_MAX_TIMEOUT_MS;

  let lastOut = null;
  for (let attempt = 1; attempt <= COLLECTOR_DRIVER_MAX_ATTEMPTS; attempt += 1) {
    try {
      const out = await withTimeout(callCollect(collectFn, eyeConfig, budgets), budgetTimeoutMs);
      const normalized = normalizeCollectResult(out);
      lastOut = normalized;
      if (normalized.success === true) return normalized;
      if (attempt < COLLECTOR_DRIVER_MAX_ATTEMPTS && isRetryableCollectResult(normalized)) {
        await waitMs(COLLECTOR_DRIVER_RETRY_BACKOFF_MS * attempt);
        continue;
      }
      return normalized;
    } catch (err) {
      const message = String(err && err.message ? err.message : err || 'collector_failed');
      const code = message.toLowerCase().includes('timeout') ? 'timeout' : 'collector_error';
      lastOut = {
        ok: false,
        success: false,
        items: [],
        bytes: 0,
        duration_ms: 0,
        requests: 0,
        error: message.slice(0, 240),
        error_code: code,
        error_http_status: null,
        degraded: false,
        cache_hit: false
      };
      if (attempt < COLLECTOR_DRIVER_MAX_ATTEMPTS && collectRetryableCode(code)) {
        await waitMs(COLLECTOR_DRIVER_RETRY_BACKOFF_MS * attempt);
        continue;
      }
      return lastOut;
    }
  }
  return lastOut || {
    ok: false,
    success: false,
    items: [],
    bytes: 0,
    duration_ms: 0,
    requests: 0,
    error: 'collector_failed',
    error_code: 'collector_error',
    error_http_status: null,
    degraded: false,
    cache_hit: false
  };
}

async function preflightWithDriver(eyeConfig) {
  const parserType = normalizeKey(eyeConfig && eyeConfig.parser_type);
  const budgets = eyeConfig && eyeConfig.budgets ? eyeConfig.budgets : {};
  if (parserType === 'stub') {
    return {
      ok: true,
      parser_type: parserType,
      checks: [{ name: 'stub_source', ok: true }],
      failures: []
    };
  }

  const loaded = loadCollectorModule(parserType);
  if (!loaded.ok) {
    return {
      ok: false,
      parser_type: parserType || 'unknown',
      checks: [],
      failures: [{ code: loaded.error || 'collector_module_missing', message: `collector module missing for parser_type: ${parserType}` }]
    };
  }

  const preflightFn = findFn(loaded.module, ['preflight'], ['preflight']);
  if (!preflightFn) {
    return {
      ok: true,
      parser_type: parserType,
      checks: [{ name: 'collector_supported', ok: true }],
      failures: []
    };
  }

  try {
    const rep = await callPreflight(preflightFn, eyeConfig, budgets);
    if (rep && typeof rep === 'object') return normalizePreflightResult(rep, parserType);
  } catch (err) {
    return {
      ok: false,
      parser_type: parserType,
      checks: [],
      failures: [{ code: 'preflight_error', message: String(err && err.message ? err.message : err || 'preflight_failed').slice(0, 180) }]
    };
  }

  return {
    ok: false,
    parser_type: parserType,
    checks: [],
    failures: [{ code: 'preflight_error', message: 'invalid_preflight_response' }]
  };
}

module.exports = {
  ADAPTIVE_COLLECTOR_DIR,
  hasCollector,
  listCollectors,
  collectWithDriver,
  preflightWithDriver
};
export {};
