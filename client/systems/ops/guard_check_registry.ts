#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_REGISTRY_PATH = path.join(ROOT, 'config', 'guard_check_registry.json');

function cleanText(v: unknown, maxLen = 240) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeToken(v: unknown, maxLen = 120) {
  return cleanText(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.:/-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function readJsonSafe(absPath: string, fallback: AnyObj = {}) {
  try {
    if (!fs.existsSync(absPath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(absPath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (const tok of argv) {
    if (!String(tok || '').startsWith('--')) {
      out._.push(String(tok || ''));
      continue;
    }
    const idx = tok.indexOf('=');
    if (idx < 0) out[String(tok || '').slice(2)] = true;
    else out[String(tok || '').slice(2, idx)] = String(tok || '').slice(idx + 1);
  }
  return out;
}

function resolveRegistryPath(rawPath?: unknown) {
  const txt = cleanText(rawPath || process.env.GUARD_CHECK_REGISTRY_PATH || '', 520);
  if (!txt) return DEFAULT_REGISTRY_PATH;
  return path.isAbsolute(txt) ? txt : path.join(ROOT, txt);
}

function normalizeCheck(row: AnyObj, index: number, prefix: string) {
  const id = normalizeToken(row && row.id ? row.id : `${prefix}_${index + 1}`, 160) || `${prefix}_${index + 1}`;
  const command = cleanText(row && row.command ? row.command : 'node', 120) || 'node';
  const args = Array.isArray(row && row.args)
    ? row.args.map((x: unknown) => cleanText(x, 240)).filter(Boolean)
    : [];
  return {
    id,
    command,
    args,
    strict: row && row.strict === true
  };
}

function loadGuardCheckRegistry(registryPath?: unknown) {
  const absPath = resolveRegistryPath(registryPath);
  const raw = readJsonSafe(absPath, {});

  const mergeGuardRaw = raw.merge_guard && typeof raw.merge_guard === 'object' ? raw.merge_guard : {};
  const checksRaw = Array.isArray(mergeGuardRaw.checks) ? mergeGuardRaw.checks : [];
  const optionalRaw = Array.isArray(mergeGuardRaw.optional_checks) ? mergeGuardRaw.optional_checks : [];

  const contractRaw = raw.contract_check && typeof raw.contract_check === 'object' ? raw.contract_check : {};
  const requiredMergeIds = Array.isArray(contractRaw.required_merge_guard_ids)
    ? contractRaw.required_merge_guard_ids.map((x: unknown) => normalizeToken(x, 160)).filter(Boolean)
    : [];

  return {
    path: absPath,
    schema_id: cleanText(raw.schema_id || 'guard_check_registry', 80) || 'guard_check_registry',
    schema_version: cleanText(raw.schema_version || '1.0.0', 40) || '1.0.0',
    generated_at: cleanText(raw.generated_at || '', 80),
    generated_from: cleanText(raw.generated_from || '', 200),
    merge_guard: {
      checks: checksRaw.map((row: AnyObj, idx: number) => normalizeCheck(row, idx, 'check')),
      optional_checks: optionalRaw.map((row: AnyObj, idx: number) => {
        const normalized = normalizeCheck(row, idx, 'optional_check');
        return {
          ...normalized,
          enabled_when: cleanText(row && row.enabled_when ? row.enabled_when : '', 80)
        };
      })
    },
    contract_check: {
      required_merge_guard_ids: requiredMergeIds
    }
  };
}

function buildMergeGuardPlan(registry: AnyObj, opts: AnyObj = {}) {
  const includeOptional = opts.skipTests !== true;
  const checks = [...(registry && registry.merge_guard && Array.isArray(registry.merge_guard.checks) ? registry.merge_guard.checks : [])];
  if (includeOptional) {
    const optionals = registry && registry.merge_guard && Array.isArray(registry.merge_guard.optional_checks)
      ? registry.merge_guard.optional_checks
      : [];
    for (const row of optionals) {
      const cond = normalizeToken(row && row.enabled_when ? row.enabled_when : '', 80);
      if (cond === 'skip_tests=false' || cond === 'skip-tests=false' || !cond) checks.push(row);
    }
  }
  return checks;
}

function validateGuardCheckRegistry(registry: AnyObj) {
  const normalizeScriptRel = (value: unknown) => {
    const rel = cleanText(value, 320).replace(/\\/g, '/');
    if (!rel) return rel;
    return rel.startsWith('client/') ? rel.slice('client/'.length) : rel;
  };
  const resolveScriptAbs = (relPath: string) => {
    const abs = path.isAbsolute(relPath) ? relPath : path.join(ROOT, relPath);
    if (fs.existsSync(abs)) return abs;
    if (abs.endsWith('.js')) {
      const tsAbs = `${abs.slice(0, -3)}.ts`;
      if (fs.existsSync(tsAbs)) return tsAbs;
    }
    return null;
  };
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!registry || typeof registry !== 'object') {
    return {
      ok: false,
      errors: ['registry_missing'],
      warnings: []
    };
  }
  if (registry.schema_id !== 'guard_check_registry') {
    errors.push('schema_id_mismatch');
  }

  const checks = buildMergeGuardPlan(registry, { skipTests: false });
  if (!checks.length) errors.push('merge_guard_checks_empty');

  const seen = new Set<string>();
  for (const row of checks) {
    const id = normalizeToken(row && row.id ? row.id : '', 160);
    if (!id) {
      errors.push('merge_guard_check_missing_id');
      continue;
    }
    if (seen.has(id)) errors.push(`duplicate_check_id:${id}`);
    seen.add(id);

    const command = cleanText(row && row.command ? row.command : '', 80);
    if (!command) errors.push(`missing_command:${id}`);
    const args = Array.isArray(row && row.args) ? row.args : [];
    if (!args.length) warnings.push(`empty_args:${id}`);
    if (command === 'node' && args.length) {
      const rel = normalizeScriptRel(args[0]);
      const abs = resolveScriptAbs(rel);
      if (!abs) {
        errors.push(`missing_script:${id}:${cleanText(args[0], 320)}`);
      }
    }
  }

  const requiredMergeIds = registry && registry.contract_check
    && Array.isArray(registry.contract_check.required_merge_guard_ids)
    ? registry.contract_check.required_merge_guard_ids
    : [];
  for (const req of requiredMergeIds) {
    if (!seen.has(normalizeToken(req, 160))) {
      errors.push(`required_merge_guard_id_missing:${req}`);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings
  };
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/guard_check_registry.js status [--registry=<path>]');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || 'status');
  if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
    usage();
    process.exit(0);
  }
  if (cmd !== 'status') {
    usage();
    process.exit(2);
  }

  const registry = loadGuardCheckRegistry(args.registry);
  const validation = validateGuardCheckRegistry(registry);
  const payload = {
    ok: validation.ok,
    schema_id: registry.schema_id,
    schema_version: registry.schema_version,
    registry_path: path.relative(ROOT, registry.path).replace(/\\/g, '/'),
    merge_guard_check_count: buildMergeGuardPlan(registry, { skipTests: false }).length,
    required_merge_guard_ids: registry.contract_check.required_merge_guard_ids,
    errors: validation.errors,
    warnings: validation.warnings
  };
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  if (!validation.ok) process.exit(1);
}

if (require.main === module) {
  main();
}

module.exports = {
  ROOT,
  DEFAULT_REGISTRY_PATH,
  loadGuardCheckRegistry,
  buildMergeGuardPlan,
  validateGuardCheckRegistry
};
