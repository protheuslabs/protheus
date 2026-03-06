#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-028
 * Optional in-process Rust binding lane (`napi-rs`) with deterministic fallback.
 */

const fs = require('fs');
const path = require('path');

type AnyObj = Record<string, any>;

let cachedPath = '';
let cachedBinding: AnyObj | null = null;
let cachedError = '';

function cleanText(v: unknown, maxLen = 240) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function toBool(v: unknown, fallback = false) {
  if (v == null) return fallback;
  const raw = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function candidatePaths(explicitPath: string, cratePath: string) {
  const out: string[] = [];
  if (explicitPath) out.push(path.resolve(explicitPath));
  if (cratePath) {
    out.push(path.join(cratePath, 'index.node'));
    out.push(path.join(cratePath, 'index.js'));
    out.push(path.join(cratePath, 'target', 'release', 'index.node'));
    out.push(path.join(cratePath, 'target', 'release', 'protheus_memory_core.node'));
    out.push(path.join(cratePath, 'target', 'release', 'protheus_memory_core_v6.node'));
  }
  out.push('@protheus/memory-core');
  out.push('protheus-memory-core');
  out.push('@protheus/memory-core-v6');
  out.push('protheus-memory-core-v6');
  return Array.from(new Set(out));
}

function loadRustNapiBinding(opts: AnyObj = {}) {
  const enabled = toBool(opts.enabled, true);
  if (!enabled) {
    return { ok: false, error: 'napi_disabled' };
  }

  const explicitPath = cleanText(opts.module_path || '', 500);
  const cratePath = cleanText(opts.crate_path || '', 500);
  const key = `${explicitPath}|${cratePath}`;
  if (cachedBinding && cachedPath === key) {
    return { ok: true, binding: cachedBinding, module_path: cleanText(cachedPath, 500) };
  }
  if (cachedError && cachedPath === key) {
    return { ok: false, error: cachedError };
  }

  const candidates = candidatePaths(explicitPath, cratePath);
  const errors: string[] = [];
  for (const candidate of candidates) {
    try {
      if (candidate.startsWith('/') && !fs.existsSync(candidate)) {
        errors.push(`missing:${candidate}`);
        continue;
      }
      // eslint-disable-next-line import/no-dynamic-require, global-require
      const loaded = require(candidate);
      const binding = loaded && typeof loaded === 'object'
        ? loaded
        : (loaded && loaded.default && typeof loaded.default === 'object' ? loaded.default : null);
      if (!binding) {
        errors.push(`invalid:${candidate}`);
        continue;
      }
      cachedPath = key;
      cachedBinding = binding;
      cachedError = '';
      return { ok: true, binding, module_path: candidate };
    } catch (err) {
      errors.push(`load_failed:${candidate}:${cleanText(err && (err.code || err.message) ? (err.code || err.message) : 'unknown', 80)}`);
    }
  }
  cachedPath = key;
  cachedBinding = null;
  cachedError = errors.length ? cleanText(errors[0], 200) : 'napi_binding_unavailable';
  return { ok: false, error: cachedError };
}

async function invokeRustNapi(method: string, payload: AnyObj, opts: AnyObj = {}) {
  const loaded = loadRustNapiBinding(opts);
  if (!loaded.ok) return { ok: false, error: loaded.error || 'napi_binding_unavailable' };
  const binding = loaded.binding;
  const fn = binding && typeof binding[method] === 'function'
    ? binding[method]
    : null;
  if (!fn) {
    return { ok: false, error: `napi_missing_method_${cleanText(method, 60)}` };
  }
  try {
    const result = await Promise.resolve(fn(payload || {}));
    const parsed = typeof result === 'string'
      ? (() => {
          try { return JSON.parse(result); } catch { return null; }
        })()
      : result;
    if (!parsed || typeof parsed !== 'object') {
      return { ok: false, error: 'napi_invalid_payload' };
    }
    return {
      ok: true,
      payload: parsed,
      module_path: loaded.module_path
    };
  } catch (err) {
    return {
      ok: false,
      error: `napi_call_failed_${cleanText(err && (err.code || err.message) ? (err.code || err.message) : 'unknown', 120)}`
    };
  }
}

module.exports = {
  loadRustNapiBinding,
  invokeRustNapi
};
