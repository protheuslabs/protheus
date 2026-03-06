#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-FCH-002
 * Critical path policy-coverage attestation.
 *
 * Usage:
 *   node systems/ops/critical_path_policy_coverage.js run [--strict=1|0]
 *   node systems/ops/critical_path_policy_coverage.js status
 */

const fs = require('fs');
const path = require('path');

type AnyObj = Record<string, any>;

const ROOT = process.env.CRITICAL_PATH_COVERAGE_ROOT
  ? path.resolve(process.env.CRITICAL_PATH_COVERAGE_ROOT)
  : path.resolve(__dirname, '..', '..');

const DEFAULT_POLICY_PATH = process.env.CRITICAL_PATH_COVERAGE_POLICY_PATH
  ? path.resolve(process.env.CRITICAL_PATH_COVERAGE_POLICY_PATH)
  : path.join(ROOT, 'config', 'critical_path_policy_coverage_policy.json');

function nowIso() {
  return new Date().toISOString();
}

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

function toBool(v: unknown, fallback = false) {
  if (v == null) return fallback;
  const raw = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (const token of argv) {
    if (!String(token || '').startsWith('--')) {
      out._.push(String(token || ''));
      continue;
    }
    const idx = token.indexOf('=');
    if (idx < 0) out[String(token).slice(2)] = true;
    else out[String(token).slice(2, idx)] = String(token).slice(idx + 1);
  }
  return out;
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/critical_path_policy_coverage.js run [--strict=1|0] [--policy=path]');
  console.log('  node systems/ops/critical_path_policy_coverage.js status [--policy=path]');
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function resolvePath(raw: unknown, fallbackRel: string) {
  const token = cleanText(raw || '', 500);
  if (!token) return path.join(ROOT, fallbackRel);
  return path.isAbsolute(token) ? token : path.join(ROOT, token);
}

function rel(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function readJson(filePath: string, fallback: any) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function readText(filePath: string) {
  try {
    if (!fs.existsSync(filePath)) return '';
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function writeJsonAtomic(filePath: string, value: AnyObj) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${Date.now()}-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function appendJsonl(filePath: string, row: AnyObj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function defaultPolicy() {
  return {
    schema_id: 'critical_path_policy_coverage_policy',
    schema_version: '1.0',
    enabled: true,
    strict_default: true,
    require_merge_guard_hooks: true,
    critical_paths: [],
    outputs: {
      latest_path: 'state/ops/critical_path_policy_coverage/latest.json',
      history_path: 'state/ops/critical_path_policy_coverage/history.jsonl'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const base = defaultPolicy();
  const raw = readJson(policyPath, {});
  const rows = Array.isArray(raw.critical_paths) ? raw.critical_paths : [];
  const criticalPaths = rows
    .map((row: AnyObj) => ({
      id: normalizeToken(row && row.id || '', 120),
      command_path: resolvePath(row && row.command_path || '', ''),
      policy_paths: Array.isArray(row && row.policy_paths)
        ? row.policy_paths.map((p: unknown) => resolvePath(p, '')).filter(Boolean)
        : [],
      test_paths: Array.isArray(row && row.test_paths)
        ? row.test_paths.map((p: unknown) => resolvePath(p, '')).filter(Boolean)
        : []
    }))
    .filter((row: AnyObj) => !!row.id && !!cleanText(row.command_path, 500));

  const outputs = raw.outputs && typeof raw.outputs === 'object' ? raw.outputs : {};
  return {
    schema_id: 'critical_path_policy_coverage_policy',
    schema_version: cleanText(raw.schema_version || base.schema_version, 24) || base.schema_version,
    enabled: raw.enabled !== false,
    strict_default: toBool(raw.strict_default, base.strict_default),
    require_merge_guard_hooks: toBool(raw.require_merge_guard_hooks, base.require_merge_guard_hooks),
    critical_paths: criticalPaths,
    outputs: {
      latest_path: resolvePath(outputs.latest_path, base.outputs.latest_path),
      history_path: resolvePath(outputs.history_path, base.outputs.history_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function expectedMergeGuardToken(commandPath: string) {
  const relPath = rel(path.resolve(String(commandPath || '')));
  return relPath
    .replace(/\.ts$/i, '.js')
    .replace(/\.mjs$/i, '.js')
    .replace(/\.cjs$/i, '.js');
}

function loadMergeGuardRegistryCoverage() {
  const out = {
    available: false,
    registry_path: null as string | null,
    validation_ok: false,
    validation_errors: [] as string[],
    command_paths: new Set<string>()
  };
  try {
    // Merge guard now delegates command wiring to the generated guard registry.
    const mod = require('./guard_check_registry');
    const registry = mod.loadGuardCheckRegistry(process.env.GUARD_CHECK_REGISTRY_PATH);
    const validation = mod.validateGuardCheckRegistry(registry);
    const checks = mod.buildMergeGuardPlan(registry, { skipTests: false });
    for (const row of checks) {
      const command = cleanText(row && row.command ? row.command : '', 80);
      if (command !== 'node') continue;
      const args = Array.isArray(row && row.args) ? row.args : [];
      if (!args.length) continue;
      const scriptArg = cleanText(args[0], 320);
      if (!scriptArg) continue;
      const abs = path.isAbsolute(scriptArg) ? path.resolve(scriptArg) : path.join(ROOT, scriptArg);
      out.command_paths.add(rel(abs));
    }
    out.available = true;
    out.registry_path = rel(path.resolve(registry.path || ''));
    out.validation_ok = validation.ok === true;
    out.validation_errors = Array.isArray(validation.errors)
      ? validation.errors.map((row: unknown) => cleanText(row, 200)).filter(Boolean)
      : [];
  } catch (err) {
    out.available = false;
    out.registry_path = null;
    out.validation_ok = false;
    out.validation_errors = [cleanText(err && (err as AnyObj).message, 200) || 'registry_load_failed'];
  }
  return out;
}

function evaluate(policy: AnyObj) {
  const registryCoverage = loadMergeGuardRegistryCoverage();
  const rows: AnyObj[] = [];

  for (const cp of policy.critical_paths) {
    const missing: string[] = [];
    const commandExists = fs.existsSync(cp.command_path);
    if (!commandExists) missing.push(`command_missing:${rel(cp.command_path)}`);

    const missingPolicies = cp.policy_paths
      .filter((p: string) => !fs.existsSync(p))
      .map((p: string) => rel(p));
    const missingTests = cp.test_paths
      .filter((p: string) => !fs.existsSync(p))
      .map((p: string) => rel(p));
    if (missingPolicies.length > 0) missing.push(`policy_missing:${missingPolicies.join(',')}`);
    if (missingTests.length > 0) missing.push(`test_missing:${missingTests.join(',')}`);

    const expectedHook = expectedMergeGuardToken(cp.command_path);
    let mergeGuardHookPresent = true;
    let mergeGuardHookSource = 'disabled';
    if (policy.require_merge_guard_hooks) {
      mergeGuardHookSource = 'guard_check_registry';
      if (!registryCoverage.available) {
        mergeGuardHookPresent = false;
        missing.push('merge_guard_registry_unavailable');
      } else {
        mergeGuardHookPresent = registryCoverage.command_paths.has(expectedHook);
        if (!mergeGuardHookPresent) missing.push(`merge_guard_hook_missing:${expectedHook}`);
      }
    }

    rows.push({
      id: cp.id,
      command_path: rel(cp.command_path),
      policy_paths: cp.policy_paths.map((p: string) => rel(p)),
      test_paths: cp.test_paths.map((p: string) => rel(p)),
      command_exists: commandExists,
      policy_coverage_ok: missingPolicies.length === 0,
      test_coverage_ok: missingTests.length === 0,
      merge_guard_hook_ok: mergeGuardHookPresent,
      merge_guard_hook_source: mergeGuardHookSource,
      expected_merge_guard_command: expectedHook,
      uncovered_reasons: missing
    });
  }

  const uncovered = rows.filter((row) => Array.isArray(row.uncovered_reasons) && row.uncovered_reasons.length > 0);
  const coverageRatio = rows.length > 0
    ? Number(((rows.length - uncovered.length) / rows.length).toFixed(4))
    : 1;
  return {
    ok: uncovered.length === 0,
    total_paths: rows.length,
    covered_paths: rows.length - uncovered.length,
    uncovered_paths: uncovered.length,
    coverage_ratio: coverageRatio,
    merge_guard_registry: {
      available: registryCoverage.available,
      registry_path: registryCoverage.registry_path,
      validation_ok: registryCoverage.validation_ok,
      validation_errors: registryCoverage.validation_errors,
      command_paths_indexed: registryCoverage.command_paths.size
    },
    rows
  };
}

function cmdRun(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  if (policy.enabled !== true) {
    const out = {
      ok: false,
      type: 'critical_path_policy_coverage',
      ts: nowIso(),
      error: 'policy_disabled',
      policy_path: rel(policy.policy_path)
    };
    process.stdout.write(`${JSON.stringify(out)}\n`);
    process.exit(1);
  }
  const strict = toBool(args.strict, policy.strict_default);
  const coverage = evaluate(policy);
  const out = {
    ok: coverage.ok === true,
    type: 'critical_path_policy_coverage',
    ts: nowIso(),
    strict,
    policy_path: rel(policy.policy_path),
    coverage
  };
  writeJsonAtomic(policy.outputs.latest_path, out);
  appendJsonl(policy.outputs.history_path, out);
  process.stdout.write(`${JSON.stringify(out)}\n`);
  if (strict && out.ok !== true) process.exit(1);
}

function cmdStatus(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const latest = readJson(policy.outputs.latest_path, null);
  if (!latest || typeof latest !== 'object') {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      type: 'critical_path_policy_coverage_status',
      error: 'latest_missing',
      latest_path: rel(policy.outputs.latest_path),
      policy_path: rel(policy.policy_path)
    })}\n`);
    process.exit(1);
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'critical_path_policy_coverage_status',
    ts: nowIso(),
    policy_path: rel(policy.policy_path),
    latest_path: rel(policy.outputs.latest_path),
    payload: latest
  })}\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || '', 80);
  if (!cmd || cmd === 'help' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'run') return cmdRun(args);
  if (cmd === 'status') return cmdStatus(args);
  usage();
  process.exit(2);
}

if (require.main === module) {
  main();
}

module.exports = {
  DEFAULT_POLICY_PATH,
  loadPolicy,
  evaluate
};
