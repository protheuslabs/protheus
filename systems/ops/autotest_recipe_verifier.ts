#!/usr/bin/env node
'use strict';
export {};

/**
 * autotest_recipe_verifier.js
 *
 * V2-050 scaffold:
 * - Verifies doctor recipes against recent failure signatures in a sandbox-safe way.
 * - Persists verification state consumed by autotest_doctor rollout gating.
 *
 * Usage:
 *   node systems/ops/autotest_recipe_verifier.js run [YYYY-MM-DD|latest] [--policy=path] [--recipe-id=<id>]
 *   node systems/ops/autotest_recipe_verifier.js status [--policy=path]
 */

const fs = require('fs');
const path = require('path');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = path.join(ROOT, 'config', 'autotest_doctor_policy.json');
const DEFAULT_AUTOTEST_RUNS_DIR = path.join(ROOT, 'state', 'ops', 'autotest', 'runs');

function nowIso() {
  return new Date().toISOString();
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (const tok of argv) {
    const raw = String(tok || '');
    if (!raw.startsWith('--')) {
      out._.push(raw);
      continue;
    }
    const idx = raw.indexOf('=');
    if (idx === -1) out[raw.slice(2)] = true;
    else out[raw.slice(2, idx)] = raw.slice(idx + 1);
  }
  return out;
}

function clean(v: unknown, maxLen = 240) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeToken(v: unknown, maxLen = 80) {
  return clean(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
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

function writeJsonAtomic(filePath: string, value: AnyObj) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${Date.now()}-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function readJsonl(filePath: string) {
  try {
    if (!fs.existsSync(filePath)) return [];
    return String(fs.readFileSync(filePath, 'utf8') || '')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter((row) => row && typeof row === 'object');
  } catch {
    return [];
  }
}

function relPath(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function resolvePath(raw: unknown, fallbackRel: string) {
  const s = clean(raw, 260);
  if (!s) return path.join(ROOT, fallbackRel);
  return path.isAbsolute(s) ? s : path.join(ROOT, s);
}

function toDate(v: unknown) {
  const raw = String(v || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  return nowIso().slice(0, 10);
}

function normalizeTokenList(v: unknown, maxLen = 64) {
  return (Array.isArray(v) ? v : [])
    .map((row) => normalizeToken(row, maxLen))
    .filter(Boolean);
}

function normalizeRecipe(row: AnyObj) {
  const src = row && typeof row === 'object' ? row : {};
  return {
    id: normalizeToken(src.id, 80),
    enabled: src.enabled !== false,
    applies_to: normalizeTokenList(src.applies_to, 48),
    steps: normalizeTokenList(src.steps, 80)
  };
}

function loadPolicy(policyPath: string) {
  const raw = readJson(policyPath, {});
  const recipes = Array.isArray(raw.recipes) ? raw.recipes.map((row) => normalizeRecipe(row)).filter((row) => row.id) : [];
  const rollout = raw.recipe_rollout && typeof raw.recipe_rollout === 'object' ? raw.recipe_rollout : {};
  return {
    recipe_rollout: {
      verifier_state_path: clean(rollout.verifier_state_path || 'state/ops/autotest_doctor/recipe_verifier_state.json', 260),
      verification_max_age_hours: Number(rollout.verification_max_age_hours || 168)
    },
    recipes
  };
}

function classifyFailureKind(result: AnyObj) {
  if (result && result.guard_ok === false) return 'guard_blocked';
  if (result && result.flaky === true) return 'flaky';
  const errBlob = [
    String(result && result.stderr_excerpt || ''),
    String(result && result.stdout_excerpt || ''),
    String(result && result.guard_reason || '')
  ].join(' ').toLowerCase();
  if (/etimedout|timeout|process_timeout|timed out/.test(errBlob)) return 'timeout';
  const exitCode = Number(result && result.exit_code);
  if (Number.isFinite(exitCode) && exitCode !== 0) return 'exit_nonzero';
  return 'assertion_failed';
}

function extractTrustedTestPath(command: unknown) {
  const cmd = String(command || '').trim();
  if (!cmd) return { path: null, trusted: false, reason: 'missing_command' };
  if (/\||&&|;|\$\(|`|>|<|\n/.test(cmd)) return { path: null, trusted: false, reason: 'shell_meta_detected' };
  const m = cmd.match(/^node\s+([^\s]+\.test\.js)\b/i);
  if (!m) return { path: null, trusted: false, reason: 'non_node_test_command' };
  const rel = String(m[1] || '').replace(/^['"]|['"]$/g, '').replace(/\\/g, '/');
  if (!rel.startsWith('memory/tools/tests/') || rel.includes('..')) {
    return { path: null, trusted: false, reason: 'path_outside_allowlist' };
  }
  return { path: rel, trusted: true, reason: null };
}

function collectFailures(runRow: AnyObj) {
  const out = [] as AnyObj[];
  const results = Array.isArray(runRow && runRow.results) ? runRow.results : [];
  for (const result of results) {
    if (!result || typeof result !== 'object') continue;
    const failed = result.ok !== true || result.guard_ok === false;
    if (!failed) continue;
    const testMeta = extractTrustedTestPath(result.command);
    out.push({
      kind: classifyFailureKind(result),
      test_id: clean(result.id || '', 120) || null,
      test_path: testMeta.path,
      trusted_test_command: testMeta.trusted === true,
      untrusted_reason: testMeta.trusted === true ? null : testMeta.reason
    });
  }
  return out;
}

function listRunFiles(runsDir: string) {
  try {
    if (!fs.existsSync(runsDir)) return [];
    return fs.readdirSync(runsDir)
      .filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
      .sort();
  } catch {
    return [];
  }
}

function loadLatestRun(runsDir: string, dateArg: string) {
  const key = String(dateArg || 'latest').trim().toLowerCase();
  const files = listRunFiles(runsDir);
  const target = key === 'latest' ? files.slice().reverse() : [`${toDate(key)}.jsonl`];
  for (const name of target) {
    const fp = path.join(runsDir, name);
    const rows = readJsonl(fp);
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const row = rows[i];
      if (String(row && row.type || '') !== 'autotest_run') continue;
      return { file_path: fp, file_date: name.replace(/\.jsonl$/, ''), row };
    }
  }
  return null;
}

function evaluateRecipe(recipe: AnyObj, failures: AnyObj[]) {
  const allowedSteps = new Set(['retest_failed_test', 'autotest_sync', 'autotest_run_changed']);
  const violations = [] as string[];
  const steps = Array.isArray(recipe && recipe.steps) ? recipe.steps : [];
  for (const step of steps) {
    if (!allowedSteps.has(String(step))) violations.push(`unsupported_step:${String(step)}`);
  }
  const applies = Array.isArray(recipe && recipe.applies_to) ? recipe.applies_to : [];
  const matched = failures.filter((row) => applies.includes(String(row && row.kind || '')));
  if (matched.length === 0) violations.push('no_matching_failure_samples');
  if (steps.includes('retest_failed_test')) {
    const hasTrusted = matched.some((row) => row && row.trusted_test_command === true && row.test_path);
    if (!hasTrusted) violations.push('missing_trusted_test_path_for_retest');
  }
  return {
    ok: violations.length === 0,
    sample_count: matched.length,
    violations
  };
}

function runVerifier(dateArg: string, args: AnyObj) {
  const policyPath = path.resolve(String(args.policy || DEFAULT_POLICY_PATH));
  const policy = loadPolicy(policyPath);
  const runsDir = process.env.AUTOTEST_DOCTOR_AUTOTEST_RUNS_DIR
    ? path.resolve(process.env.AUTOTEST_DOCTOR_AUTOTEST_RUNS_DIR)
    : DEFAULT_AUTOTEST_RUNS_DIR;
  const verifierStatePath = resolvePath(
    policy.recipe_rollout && policy.recipe_rollout.verifier_state_path,
    'state/ops/autotest_doctor/recipe_verifier_state.json'
  );
  const latest = loadLatestRun(runsDir, dateArg || 'latest');
  const failures = collectFailures(latest && latest.row ? latest.row : {});
  const onlyRecipeId = normalizeToken(args['recipe-id'] || '', 80);
  const rows = policy.recipes.filter((row: AnyObj) => row.enabled !== false && (!onlyRecipeId || row.id === onlyRecipeId));

  const recipesOut: AnyObj = {};
  const checks = [] as AnyObj[];
  for (const recipe of rows) {
    const evaluation = evaluateRecipe(recipe, failures);
    const row = {
      verified_at: nowIso(),
      ok: evaluation.ok === true,
      sample_count: Number(evaluation.sample_count || 0),
      violations: evaluation.violations
    };
    recipesOut[recipe.id] = row;
    checks.push({
      recipe_id: recipe.id,
      ...row
    });
  }

  const state = {
    version: '1.0',
    ts: nowIso(),
    source_run: latest
      ? {
          file_path: relPath(latest.file_path),
          file_date: latest.file_date
        }
      : null,
    recipes: recipesOut
  };
  writeJsonAtomic(verifierStatePath, state);
  return {
    ok: true,
    type: 'autotest_recipe_verifier_run',
    ts: state.ts,
    run_date: latest && latest.file_date ? latest.file_date : null,
    source_run_path: latest ? relPath(latest.file_path) : null,
    recipes_checked: checks.length,
    recipes_passed: checks.filter((row) => row.ok === true).length,
    checks,
    verifier_state_path: relPath(verifierStatePath)
  };
}

function status(args: AnyObj) {
  const policyPath = path.resolve(String(args.policy || DEFAULT_POLICY_PATH));
  const policy = loadPolicy(policyPath);
  const verifierStatePath = resolvePath(
    policy.recipe_rollout && policy.recipe_rollout.verifier_state_path,
    'state/ops/autotest_doctor/recipe_verifier_state.json'
  );
  const payload = readJson(verifierStatePath, null);
  if (!payload || typeof payload !== 'object') {
    return {
      ok: false,
      type: 'autotest_recipe_verifier_status',
      error: 'verifier_state_missing',
      verifier_state_path: relPath(verifierStatePath)
    };
  }
  const recipes = payload.recipes && typeof payload.recipes === 'object' ? payload.recipes : {};
  const entries = Object.entries(recipes).map(([recipeId, row]) => ({
    recipe_id: recipeId,
    ok: !!(row && (row as AnyObj).ok === true),
    verified_at: clean((row as AnyObj).verified_at || '', 64) || null,
    sample_count: Number((row as AnyObj).sample_count || 0),
    violations: Array.isArray((row as AnyObj).violations) ? (row as AnyObj).violations : []
  }));
  return {
    ok: true,
    type: 'autotest_recipe_verifier_status',
    ts: clean(payload.ts || '', 64) || null,
    recipes_checked: entries.length,
    recipes_passed: entries.filter((row) => row.ok).length,
    checks: entries,
    verifier_state_path: relPath(verifierStatePath)
  };
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/autotest_recipe_verifier.js run [YYYY-MM-DD|latest] [--policy=path] [--recipe-id=<id>]');
  console.log('  node systems/ops/autotest_recipe_verifier.js status [--policy=path]');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim().toLowerCase();
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    usage();
    process.exit(0);
  }
  if (cmd === 'run') {
    const payload = runVerifier(args._[1] || 'latest', args);
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    return;
  }
  if (cmd === 'status') {
    const payload = status(args);
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    if (payload.ok !== true) process.exitCode = 1;
    return;
  }
  usage();
  process.exit(2);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      type: 'autotest_recipe_verifier',
      error: clean(err && err.message ? err.message : err || 'autotest_recipe_verifier_failed', 220)
    })}\n`);
    process.exit(1);
  }
}

