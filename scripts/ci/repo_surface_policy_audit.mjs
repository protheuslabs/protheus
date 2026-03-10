#!/usr/bin/env node
/* eslint-disable no-console */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const ROOT = process.cwd();
const SOURCE_RE = /\.(rs|c|cc|cpp|h|hpp|ts|tsx|js|jsx|py|sh|ps1|html|css|scss)$/;

function parseArgs(argv) {
  const out = {
    policy: 'client/runtime/config/repo_surface_policy.json',
    out: '',
    strict: false,
  };
  for (const arg of argv) {
    if (arg.startsWith('--policy=')) out.policy = arg.slice('--policy='.length);
    else if (arg.startsWith('--out=')) out.out = arg.slice('--out='.length);
    else if (arg.startsWith('--strict=')) {
      const v = String(arg.slice('--strict='.length)).toLowerCase();
      out.strict = ['1', 'true', 'yes', 'on'].includes(v);
    } else if (arg === '--strict') out.strict = true;
  }
  return out;
}

function rel(p) {
  return path.relative(ROOT, p).replace(/\\/g, '/');
}

function extOf(file) {
  const ext = path.extname(file).toLowerCase().replace(/^\./, '');
  return ext || '<none>';
}

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      // Treat nested git repositories as external/vendor surfaces and do not audit inside them.
      if (fs.existsSync(path.join(abs, '.git'))) continue;
      walk(abs, out);
      continue;
    }
    if (SOURCE_RE.test(ent.name)) out.push(abs);
  }
  return out;
}

function startsWithAny(value, prefixes) {
  return prefixes.some((prefix) => value.startsWith(prefix));
}

function countByExt(files) {
  const counts = {};
  for (const file of files) {
    const ext = extOf(file);
    counts[ext] = (counts[ext] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const policyPath = path.resolve(ROOT, args.policy);
  const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8'));

  let revision = 'unknown';
  try {
    revision = execSync('git rev-parse HEAD', { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {}

  const codeRoots = Array.isArray(policy.code_roots) ? policy.code_roots : [];
  const runtimeExceptions = Array.isArray(policy.runtime_exceptions) ? policy.runtime_exceptions : [];
  const ignorePathPrefixes = Array.isArray(policy.ignore_path_prefixes)
    ? policy.ignore_path_prefixes
    : [];
  const ignoreExactPaths = new Set(Array.isArray(policy.ignore_exact_paths) ? policy.ignore_exact_paths : []);
  const rootRules = policy.root_rules || {};

  const rootSummaries = {};
  const hardViolations = [];
  const targetGaps = [];

  for (const root of codeRoots) {
    const absRoot = path.resolve(ROOT, root);
    const files = walk(absRoot)
      .map(rel)
      .filter((file) => !startsWithAny(file, ignorePathPrefixes))
      .filter((file) => !ignoreExactPaths.has(file));
    const rule = rootRules[root] || {};
    const allowed = new Set([...(rule.allowed_extensions || []), ...(rule.target_extensions || []), ...(rule.legacy_debt_extensions || [])]);
    const badFiles = files.filter((file) => !allowed.has(extOf(file)));
    if (badFiles.length > 0) {
      for (const file of badFiles) {
        hardViolations.push({
          root,
          file,
          reason: 'extension_not_allowed_for_root',
          ext: extOf(file),
        });
      }
    }

    const legacyDebtExts = new Set(rule.legacy_debt_extensions || []);
    const legacyDebtFiles = files.filter((file) => legacyDebtExts.has(extOf(file)));
    if (legacyDebtFiles.length > 0) {
      targetGaps.push({
        root,
        reason: 'legacy_extension_debt',
        count: legacyDebtFiles.length,
        by_ext: countByExt(legacyDebtFiles),
      });
    }

    rootSummaries[root] = {
      exists: fs.existsSync(absRoot),
      file_count: files.length,
      by_ext: countByExt(files),
    };
  }

  // Source files outside declared roots are allowed only in explicitly-declared infra exceptions.
  const allSource = walk(ROOT).map(rel);
  const outside = allSource.filter((file) => {
    if (startsWithAny(file, ignorePathPrefixes)) return false;
    if (ignoreExactPaths.has(file)) return false;
    if (startsWithAny(file, codeRoots.map((r) => `${r}/`))) return false;
    if (startsWithAny(file, runtimeExceptions)) return false;
    return true;
  });
  for (const file of outside) {
    hardViolations.push({
      root: '<outside>',
      file,
      reason: 'source_outside_declared_roots',
      ext: extOf(file),
    });
  }

  const payload = {
    type: 'repo_surface_policy_audit',
    generated_at: new Date().toISOString(),
    revision,
    policy_path: rel(policyPath),
    summary: {
      hard_violation_count: hardViolations.length,
      target_gap_count: targetGaps.length,
      pass: hardViolations.length === 0,
    },
    roots: rootSummaries,
    target_gaps: targetGaps,
    hard_violations: hardViolations,
  };

  if (args.out) {
    const outPath = path.resolve(ROOT, args.out);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);
  }

  console.log(JSON.stringify(payload, null, 2));
  if (args.strict && hardViolations.length > 0) process.exit(1);
}

main();
