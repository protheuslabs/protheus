#!/usr/bin/env node
/* eslint-disable no-console */
import fs from 'node:fs';
import path from 'node:path';
import { execSync, spawnSync } from 'node:child_process';

const ROOT = process.cwd();
const SOURCE_RE = /\.(rs|c|cc|cpp|h|hpp|ts|tsx|js|jsx|py|sh|ps1|html|css|scss)$/;

function parseArgs(argv) {
  const out = {
    policy: 'client/runtime/config/repo_surface_policy.json',
    out: '',
    rootContract: '',
    skipRepo: false,
    strict: false,
  };
  for (const arg of argv) {
    if (arg.startsWith('--policy=')) out.policy = arg.slice('--policy='.length);
    else if (arg.startsWith('--out=')) out.out = arg.slice('--out='.length);
    else if (arg.startsWith('--root-contract=')) out.rootContract = arg.slice('--root-contract='.length);
    else if (arg === '--skip-repo') out.skipRepo = true;
    else if (arg.startsWith('--skip-repo=')) {
      const v = String(arg.slice('--skip-repo='.length)).toLowerCase();
      out.skipRepo = ['1', 'true', 'yes', 'on'].includes(v);
    }
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

function trackedSourceFiles() {
  let out = '';
  try {
    out = execSync('git ls-files', { cwd: ROOT, encoding: 'utf8' });
  } catch {
    return [];
  }
  return out
    .split('\n')
    .map((line) => line.trim().replace(/\\/g, '/'))
    .filter(Boolean)
    .filter((file) => SOURCE_RE.test(file));
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

function isGitIgnored(entry) {
  const probe = spawnSync('git', ['check-ignore', '-q', '--', entry], {
    cwd: ROOT,
    stdio: 'ignore',
  });
  return Number.isFinite(Number(probe.status)) && Number(probe.status) === 0;
}

function buildRootSurfaceReport(rootContractPath, revision) {
  const contractPath = path.resolve(ROOT, rootContractPath);
  const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
  const allowedFiles = new Set(contract.allowed_root_files || []);
  const allowedDirs = new Set(contract.allowed_root_dirs || []);
  const deprecated = new Set(contract.deprecated_root_entries || []);
  const ignored = new Set(['.git']);
  const hardViolations = [];
  const deprecatedPresent = [];

  for (const entry of fs.readdirSync(ROOT).sort()) {
    if (ignored.has(entry)) continue;
    if (isGitIgnored(entry)) continue;
    const abs = path.join(ROOT, entry);
    const isDir = fs.lstatSync(abs).isDirectory();
    if (isDir) {
      if (allowedDirs.has(entry)) continue;
      if (deprecated.has(entry)) {
        deprecatedPresent.push(entry);
        continue;
      }
      hardViolations.push({ entry, kind: 'dir', reason: 'root_dir_not_allowlisted' });
      continue;
    }
    if (allowedFiles.has(entry)) continue;
    if (deprecated.has(entry)) {
      deprecatedPresent.push(entry);
      continue;
    }
    hardViolations.push({ entry, kind: 'file', reason: 'root_file_not_allowlisted' });
  }

  const payload = {
    type: 'root_surface_contract',
    generated_at: new Date().toISOString(),
    revision,
    policy_path: rel(contractPath),
    summary: {
      hard_violation_count: hardViolations.length,
      deprecated_present_count: deprecatedPresent.length,
      pass: hardViolations.length === 0,
    },
    deprecated_present: deprecatedPresent,
    hard_violations: hardViolations,
  };

  if (contract.paths?.latest_path) {
    const latestPath = path.resolve(ROOT, contract.paths.latest_path);
    fs.mkdirSync(path.dirname(latestPath), { recursive: true });
    fs.writeFileSync(latestPath, `${JSON.stringify(payload, null, 2)}\n`);
  }
  if (contract.paths?.receipts_path) {
    const receiptsPath = path.resolve(ROOT, contract.paths.receipts_path);
    fs.mkdirSync(path.dirname(receiptsPath), { recursive: true });
    fs.appendFileSync(receiptsPath, `${JSON.stringify(payload)}\n`);
  }

  return payload;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  let revision = 'unknown';
  try {
    revision = execSync('git rev-parse HEAD', { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {}

  if (args.skipRepo && args.rootContract) {
    const payload = buildRootSurfaceReport(args.rootContract, revision);
    console.log(JSON.stringify(payload, null, 2));
    if (args.strict && !payload.summary.pass) process.exit(1);
    return;
  }

  const policyPath = path.resolve(ROOT, args.policy);
  const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8'));

  const codeRoots = Array.isArray(policy.code_roots) ? policy.code_roots : [];
  const runtimeExceptions = Array.isArray(policy.runtime_exceptions) ? policy.runtime_exceptions : [];
  const ignorePathPrefixes = Array.isArray(policy.ignore_path_prefixes)
    ? policy.ignore_path_prefixes
    : [];
  const ignoreExactPaths = new Set(Array.isArray(policy.ignore_exact_paths) ? policy.ignore_exact_paths : []);
  const forbiddenPathPrefixes = Array.isArray(policy.forbidden_path_prefixes)
    ? policy.forbidden_path_prefixes
    : [];
  const rootRules = policy.root_rules || {};
  const trackedSources = trackedSourceFiles();

  const rootSummaries = {};
  const hardViolations = [];
  const targetGaps = [];

  const globallyForbiddenFiles = trackedSources
    .filter((file) => !startsWithAny(file, ignorePathPrefixes))
    .filter((file) => !ignoreExactPaths.has(file))
    .filter((file) => startsWithAny(file, forbiddenPathPrefixes));
  for (const file of globallyForbiddenFiles) {
    hardViolations.push({
      root: '<global>',
      file,
      reason: 'file_under_forbidden_path_prefix',
      ext: extOf(file),
    });
  }

  for (const root of codeRoots) {
    const files = trackedSources
      .filter((file) => file === root || file.startsWith(`${root}/`))
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
      exists: fs.existsSync(path.resolve(ROOT, root)),
      file_count: files.length,
      by_ext: countByExt(files),
    };
  }

  // Source files outside declared roots are allowed only in explicitly-declared infra exceptions.
  const outside = trackedSources.filter((file) => {
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

  if (args.rootContract) {
    payload.root_surface_contract = buildRootSurfaceReport(args.rootContract, revision);
    payload.summary.pass =
      payload.summary.pass && payload.root_surface_contract.summary.pass;
  }

  if (args.out) {
    const outPath = path.resolve(ROOT, args.out);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);
  }

  console.log(JSON.stringify(payload, null, 2));
  if (args.strict && !payload.summary.pass) process.exit(1);
}

main();
