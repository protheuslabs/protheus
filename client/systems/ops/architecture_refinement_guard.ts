#!/usr/bin/env node
'use strict';
export {};

/**
 * architecture_refinement_guard.js
 *
 * Implements V3-ARC-001..006 architecture refinement controls.
 */

const fs = require('fs');
const path = require('path');
const {
  ROOT,
  nowIso,
  parseArgs,
  cleanText,
  normalizeToken,
  toBool,
  clampInt,
  readJson,
  writeJsonAtomic,
  appendJsonl,
  resolvePath,
  emit
} = require('../../lib/queued_backlog_runtime');

const DEFAULT_POLICY_PATH = process.env.ARCH_REFINEMENT_POLICY_PATH
  ? path.resolve(process.env.ARCH_REFINEMENT_POLICY_PATH)
  : path.join(ROOT, 'config', 'architecture_refinement_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/architecture_refinement_guard.js run [--strict=1] [--policy=<path>] [--apply=0|1]');
  console.log('  node systems/ops/architecture_refinement_guard.js status [--policy=<path>]');
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    shadow_only: true,
    strict_default: false,
    limits: {
      max_core_loc: 1200,
      max_new_config_files: 8
    },
    high_level_organs: ['autonomy', 'security', 'memory', 'weaver', 'symbiosis', 'actuation', 'helix', 'budget', 'workflow'],
    paths: {
      systems_root: 'systems',
      config_root: 'config',
      state_root: 'state/ops/architecture_refinement',
      latest_path: 'state/ops/architecture_refinement/latest.json',
      receipts_path: 'state/ops/architecture_refinement/receipts.jsonl',
      policy_registry_path: 'state/ops/architecture_refinement/policy_registry.json',
      config_pack_path: 'state/ops/architecture_refinement/config_packs.json',
      ownership_matrix_path: 'state/ops/architecture_refinement/policy_ownership_matrix.json',
      growth_baseline_path: 'state/ops/architecture_refinement/config_growth_baseline.json'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const limits = raw.limits && typeof raw.limits === 'object' ? raw.limits : {};
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  return {
    version: cleanText(raw.version || base.version, 32),
    enabled: toBool(raw.enabled, true),
    shadow_only: toBool(raw.shadow_only, true),
    strict_default: toBool(raw.strict_default, base.strict_default),
    limits: {
      max_core_loc: clampInt(limits.max_core_loc, 200, 10000, base.limits.max_core_loc),
      max_new_config_files: clampInt(limits.max_new_config_files, 0, 500, base.limits.max_new_config_files)
    },
    high_level_organs: Array.isArray(raw.high_level_organs)
      ? raw.high_level_organs.map((v: unknown) => normalizeToken(v, 80)).filter(Boolean)
      : base.high_level_organs,
    paths: {
      systems_root: resolvePath(paths.systems_root, base.paths.systems_root),
      config_root: resolvePath(paths.config_root, base.paths.config_root),
      state_root: resolvePath(paths.state_root, base.paths.state_root),
      latest_path: resolvePath(paths.latest_path, base.paths.latest_path),
      receipts_path: resolvePath(paths.receipts_path, base.paths.receipts_path),
      policy_registry_path: resolvePath(paths.policy_registry_path, base.paths.policy_registry_path),
      config_pack_path: resolvePath(paths.config_pack_path, base.paths.config_pack_path),
      ownership_matrix_path: resolvePath(paths.ownership_matrix_path, base.paths.ownership_matrix_path),
      growth_baseline_path: resolvePath(paths.growth_baseline_path, base.paths.growth_baseline_path)
    }
  };
}

function walkFiles(rootDir, filterFn, out = []) {
  if (!fs.existsSync(rootDir)) return out;
  const ents = fs.readdirSync(rootDir, { withFileTypes: true });
  for (const ent of ents) {
    if (!ent) continue;
    if (ent.name === '.git' || ent.name === 'node_modules' || ent.name === 'dist' || ent.name === 'tmp') continue;
    const abs = path.join(rootDir, ent.name);
    if (ent.isDirectory()) {
      walkFiles(abs, filterFn, out);
      continue;
    }
    if (ent.isFile() && filterFn(abs)) out.push(abs);
  }
  return out;
}

function fileLoc(filePath) {
  try {
    const text = String(fs.readFileSync(filePath, 'utf8') || '');
    return text.split(/\r?\n/).length;
  } catch {
    return 0;
  }
}

function scanPolicyReferences(configFiles: string[], codeFiles: string[]) {
  const refs: Record<string, number> = {};
  for (const cfg of configFiles) refs[cfg] = 0;
  for (const filePath of codeFiles) {
    let text = '';
    try { text = String(fs.readFileSync(filePath, 'utf8') || ''); } catch { continue; }
    for (const cfg of configFiles) {
      const rel = path.relative(ROOT, cfg).replace(/\\/g, '/');
      if (text.includes(rel) || text.includes(path.basename(cfg))) refs[cfg] += 1;
    }
  }
  return refs;
}

function boundaryFirewallViolations(tsFiles: string[], organs: string[]) {
  const organSet = new Set(organs);
  const violations: any[] = [];
  for (const filePath of tsFiles) {
    const rel = path.relative(ROOT, filePath).replace(/\\/g, '/');
    const own = rel.startsWith('systems/') ? normalizeToken(rel.split('/')[1] || '', 80) : '';
    if (!own || !organSet.has(own)) continue;
    let text = '';
    try { text = String(fs.readFileSync(filePath, 'utf8') || ''); } catch { continue; }
    const matches = text.match(/systems\/([a-zA-Z0-9_-]+)\//g) || [];
    for (const m of matches) {
      const target = normalizeToken(String(m).replace(/^systems\//, '').replace(/\/$/, ''), 80);
      if (!target || target === own) continue;
      if (!organSet.has(target)) continue;
      const allowed = own === 'ops' || own === 'spine';
      if (!allowed) violations.push({ file: rel, from: own, to: target });
    }
  }
  return violations;
}

function runGuard(args, policy) {
  const strict = args.strict != null ? toBool(args.strict, false) : policy.strict_default;
  const apply = toBool(args.apply, false);

  const tsFiles = walkFiles(policy.paths.systems_root, (abs: string) => abs.endsWith('.ts'));
  const configFiles = walkFiles(policy.paths.config_root, (abs: string) => abs.endsWith('.json'));
  const docsAndCode = [
    ...tsFiles,
    ...walkFiles(path.join(ROOT, 'lib'), (abs: string) => abs.endsWith('.ts') || abs.endsWith('.js')),
    ...walkFiles(path.join(ROOT, 'docs'), (abs: string) => abs.endsWith('.md')),
    path.join(ROOT, 'package.json')
  ];

  const largeCoreFiles = tsFiles
    .map((filePath) => ({ file: path.relative(ROOT, filePath).replace(/\\/g, '/'), loc: fileLoc(filePath) }))
    .filter((row) => row.loc > policy.limits.max_core_loc)
    .sort((a, b) => b.loc - a.loc);

  const policyRefs = scanPolicyReferences(configFiles, docsAndCode);
  const deadPolicies = Object.entries(policyRefs)
    .filter(([, count]) => Number(count) === 0)
    .map(([filePath]) => path.relative(ROOT, filePath).replace(/\\/g, '/'));

  const boundaryViolations = boundaryFirewallViolations(tsFiles, policy.high_level_organs || []);

  const bundles: Record<string, string[]> = {};
  for (const cfg of configFiles) {
    const base = path.basename(cfg);
    const domain = normalizeToken(base.split('_')[0] || 'misc', 40) || 'misc';
    bundles[domain] = bundles[domain] || [];
    bundles[domain].push(path.relative(ROOT, cfg).replace(/\\/g, '/'));
  }

  const ownership = readJson(policy.paths.ownership_matrix_path, {
    schema_version: '1.0',
    owners: {}
  });
  ownership.owners = ownership.owners && typeof ownership.owners === 'object' ? ownership.owners : {};
  for (const cfg of configFiles) {
    const rel = path.relative(ROOT, cfg).replace(/\\/g, '/');
    if (ownership.owners[rel]) continue;
    const d = normalizeToken(path.basename(cfg).split('_')[0] || 'ops', 40) || 'ops';
    ownership.owners[rel] = `${d}_owner`;
  }

  const baseline = readJson(policy.paths.growth_baseline_path, {
    schema_version: '1.0',
    count: configFiles.length,
    updated_at: nowIso()
  });
  const growth = configFiles.length - clampInt(baseline.count, 0, 100000, configFiles.length);
  const growthExceeded = growth > policy.limits.max_new_config_files;
  if (apply && baseline.count == null) {
    baseline.count = configFiles.length;
    baseline.updated_at = nowIso();
  }

  if (apply) {
    writeJsonAtomic(policy.paths.policy_registry_path, {
      schema_version: '1.0',
      generated_at: nowIso(),
      policies: Object.fromEntries(configFiles.map((cfg) => [path.relative(ROOT, cfg).replace(/\\/g, '/'), { references: policyRefs[cfg] || 0 }]))
    });
    writeJsonAtomic(policy.paths.config_pack_path, {
      schema_version: '1.0',
      generated_at: nowIso(),
      bundles
    });
    writeJsonAtomic(policy.paths.ownership_matrix_path, ownership);
    writeJsonAtomic(policy.paths.growth_baseline_path, {
      schema_version: '1.0',
      count: clampInt(baseline.count, 0, 100000, configFiles.length),
      updated_at: nowIso()
    });
  }

  const out = {
    ts: nowIso(),
    type: 'architecture_refinement_guard_run',
    ok: true,
    strict,
    shadow_only: policy.shadow_only,
    apply,
    metrics: {
      ts_files: tsFiles.length,
      config_files: configFiles.length,
      oversized_core_files: largeCoreFiles.length,
      dead_policies: deadPolicies.length,
      boundary_violations: boundaryViolations.length,
      config_growth_delta: growth
    },
    large_core_files: largeCoreFiles.slice(0, 20),
    dead_policies: deadPolicies.slice(0, 100),
    boundary_violations: boundaryViolations.slice(0, 100),
    growth_budget_exceeded: growthExceeded
  };

  if (strict) {
    out.ok = largeCoreFiles.length === 0 && deadPolicies.length === 0 && boundaryViolations.length === 0 && !growthExceeded;
  }

  writeJsonAtomic(policy.paths.latest_path, out);
  appendJsonl(policy.paths.receipts_path, out);
  return out;
}

function status(policy) {
  const latest = readJson(policy.paths.latest_path, {});
  return {
    ok: true,
    type: 'architecture_refinement_guard_status',
    shadow_only: policy.shadow_only,
    latest
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || 'status', 80) || 'status';
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    usage();
    return;
  }

  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  if (!policy.enabled) emit({ ok: false, error: 'architecture_refinement_guard_disabled' }, 1);

  if (cmd === 'run') emit(runGuard(args, policy));
  if (cmd === 'status') emit(status(policy));

  usage();
  process.exit(1);
}

main();
