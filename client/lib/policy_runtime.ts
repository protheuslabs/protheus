'use strict';

export {};

const path = require('path') as typeof import('path');
const {
  ROOT,
  cleanText,
  readJson,
  resolvePath
} = require('./queued_backlog_runtime');

type AnyObj = Record<string, any>;

type LoadPolicyRuntimeOptions = {
  policyPath: unknown,
  defaults: AnyObj,
  normalize?: (ctx: {
    raw: AnyObj,
    defaults: AnyObj,
    merged: AnyObj,
    policyPath: string,
    root: string
  }) => AnyObj
};

function isPlainObject(v: unknown): v is AnyObj {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function clone(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((row) => clone(row));
  if (isPlainObject(value)) {
    const out: AnyObj = {};
    for (const [k, v] of Object.entries(value)) out[k] = clone(v);
    return out;
  }
  return value;
}

function deepMerge(baseValue: unknown, overrideValue: unknown): unknown {
  if (Array.isArray(baseValue)) {
    if (Array.isArray(overrideValue)) return clone(overrideValue);
    return clone(baseValue);
  }
  if (isPlainObject(baseValue)) {
    const out: AnyObj = {};
    const keys = new Set<string>([
      ...Object.keys(baseValue),
      ...(isPlainObject(overrideValue) ? Object.keys(overrideValue) : [])
    ]);
    for (const key of keys) {
      const baseEntry = (baseValue as AnyObj)[key];
      const hasOverride = isPlainObject(overrideValue)
        ? Object.prototype.hasOwnProperty.call(overrideValue, key)
        : false;
      if (!hasOverride) {
        out[key] = clone(baseEntry);
        continue;
      }
      const overrideEntry = (overrideValue as AnyObj)[key];
      out[key] = deepMerge(baseEntry, overrideEntry);
    }
    return out;
  }
  if (overrideValue === undefined) return clone(baseValue);
  return clone(overrideValue);
}

function resolvePolicyPath(rawPath: unknown) {
  const txt = cleanText(rawPath, 520);
  if (!txt) return '';
  return path.isAbsolute(txt) ? txt : path.join(ROOT, txt);
}

function loadPolicyRuntime(opts: LoadPolicyRuntimeOptions) {
  const defaults = isPlainObject(opts && opts.defaults) ? opts.defaults : {};
  const policyPath = resolvePolicyPath(opts && opts.policyPath);
  const rawLoaded = readJson(policyPath, {});
  const raw = isPlainObject(rawLoaded) ? rawLoaded : {};
  const mergedRaw = deepMerge(defaults, raw);
  const merged = isPlainObject(mergedRaw) ? mergedRaw as AnyObj : {};

  const normalize = opts && typeof opts.normalize === 'function' ? opts.normalize : null;
  const policy = normalize
    ? normalize({ raw, defaults, merged, policyPath, root: ROOT })
    : merged;

  return {
    policy,
    raw,
    defaults,
    merged,
    policy_path: policyPath
  };
}

function resolvePolicyValuePath(raw: unknown, fallbackRel: string) {
  return resolvePath(raw || fallbackRel, fallbackRel);
}

module.exports = {
  ROOT,
  loadPolicyRuntime,
  resolvePolicyPath,
  resolvePolicyValuePath,
  deepMerge
};
