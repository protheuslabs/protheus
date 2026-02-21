#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const WORKSPACE_DIR = path.join(__dirname, '..', '..');
const ADAPTIVE_COLLECTOR_DIR = process.env.ADAPTIVE_EYES_COLLECTOR_DIR
  ? path.resolve(process.env.ADAPTIVE_EYES_COLLECTOR_DIR)
  : path.join(WORKSPACE_DIR, 'adaptive', 'sensory', 'eyes', 'collectors');

function normalizeKey(v) {
  return String(v || '').trim().toLowerCase();
}

function collectorModulePath(parserType) {
  const key = normalizeKey(parserType).replace(/[^a-z0-9_\-]/g, '_');
  if (!key) return null;
  return path.join(ADAPTIVE_COLLECTOR_DIR, `${key}.js`);
}

function hasCollector(parserType) {
  const modulePath = collectorModulePath(parserType);
  return !!(modulePath && fs.existsSync(modulePath));
}

function listCollectors() {
  if (!fs.existsSync(ADAPTIVE_COLLECTOR_DIR)) return [];
  return fs.readdirSync(ADAPTIVE_COLLECTOR_DIR)
    .filter((f) => f.endsWith('.js'))
    .map((f) => f.replace(/\.js$/i, ''))
    .sort((a, b) => a.localeCompare(b));
}

function loadCollectorModule(parserType) {
  const modulePath = collectorModulePath(parserType);
  if (!modulePath || !fs.existsSync(modulePath)) {
    return { ok: false, error: 'collector_module_missing', parser_type: normalizeKey(parserType), module_path: modulePath };
  }
  try {
    // Clear cache so adaptive updates are picked up in long-running processes.
    delete require.cache[require.resolve(modulePath)];
    const mod = require(modulePath);
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
      error: loaded.error || 'collector_module_missing'
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
      error: 'collector_collect_fn_missing'
    };
  }

  const out = await callCollect(collectFn, eyeConfig, budgets);
  return normalizeCollectResult(out);
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
    if (rep && typeof rep === 'object') {
      return {
        ok: rep.ok === true,
        parser_type: rep.parser_type || parserType,
        checks: Array.isArray(rep.checks) ? rep.checks : [],
        failures: Array.isArray(rep.failures) ? rep.failures : []
      };
    }
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
