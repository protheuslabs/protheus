#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');
const {
  ROOT,
  nowIso,
  parseArgs,
  cleanText,
  toBool,
  readJson,
  writeJsonAtomic,
  appendJsonl,
  resolvePath,
  emit
} = require('../../lib/queued_backlog_runtime');

const DEFAULT_POLICY_PATH = process.env.DEPENDENCY_BOUNDARY_MANIFEST_PATH
  ? path.resolve(process.env.DEPENDENCY_BOUNDARY_MANIFEST_PATH)
  : path.join(ROOT, 'client', 'config', 'dependency_boundary_manifest.json');

type AnyObj = Record<string, any>;

function rel(absPath: string) {
  return path.relative(ROOT, absPath).replace(/\\/g, '/');
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/dependency_boundary_guard.js check [--strict=1|0] [--policy=<path>]');
  console.log('  node systems/ops/dependency_boundary_guard.js status [--policy=<path>]');
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    layers: {
      core: ['client/lib', 'client/bin'],
      config: ['client/config'],
      systems: ['client/systems'],
      adaptive: ['client/adaptive'],
      habits: ['client/habits'],
      memory: ['client/memory'],
      state: ['state'],
      docs: ['docs'],
      tests: ['client/tests', 'client/memory/tools/tests']
    },
    allow_imports: {},
    enforce_layers: [],
    enforce_cycles: true,
    conduit_boundary: {
      enabled: true,
      include_dirs: ['client/systems', 'client/lib'],
      include_ext: ['.ts', '.js'],
      exclude_contains: ['.bak.', '.tmp', 'node_modules', 'dist/', '/tests/', '.test.'],
      allowlisted_files: [
        'client/lib/direct_conduit_lane_bridge.js',
        'client/lib/legacy_retired_lane_bridge.js',
        'client/lib/spine_conduit_bridge.ts',
        'client/lib/ops_domain_conduit_runner.ts',
        'client/lib/conduit_full_lifecycle_probe.js',
        'client/systems/ops/dependency_boundary_guard.ts',
        'client/systems/ops/rust50_conf001_execution_cutover.ts',
        'client/systems/ops/rust50_sprint1_batch.ts',
        'client/systems/ops/rust50_sprint_contract.js',
        'client/systems/ops/rust_hybrid_migration_program.ts',
        'client/systems/conduit/conduit-client.ts',
        'client/systems/conduit/conduit-client.js'
      ],
      forbidden_patterns: [
        "path.join(ROOT, 'target', 'release'",
        "path.join(ROOT, 'target', 'debug'",
        '--manifest-path',
        "spawnSync('cargo'",
        'spawnSync(\"cargo\"',
        "execSync('cargo",
        'execSync(\"cargo'
      ]
    },
    scan: {
      include_dirs: ['client/systems', 'client/lib', 'client/adaptive', 'client/habits', 'client/memory/tools', 'client/tests'],
      include_ext: ['.ts', '.js'],
      exclude_contains: ['.bak.', '.tmp', 'node_modules', 'dist/']
    },
    paths: {
      latest_path: 'state/ops/dependency_boundary_guard/latest.json',
      receipts_path: 'state/ops/dependency_boundary_guard/receipts.jsonl'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const scan = raw.scan && typeof raw.scan === 'object' ? raw.scan : {};
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  const conduitBoundary = raw.conduit_boundary && typeof raw.conduit_boundary === 'object'
    ? raw.conduit_boundary
    : {};
  return {
    version: cleanText(raw.version || base.version, 24) || base.version,
    enabled: toBool(raw.enabled, true),
    layers: raw.layers && typeof raw.layers === 'object' ? raw.layers : base.layers,
    allow_imports: raw.allow_imports && typeof raw.allow_imports === 'object' ? raw.allow_imports : base.allow_imports,
    enforce_layers: Array.isArray(raw.enforce_layers)
      ? raw.enforce_layers.map((v: unknown) => cleanText(v, 80)).filter(Boolean)
      : [],
    enforce_cycles: toBool(raw.enforce_cycles, true),
    conduit_boundary: {
      enabled: toBool(conduitBoundary.enabled, true),
      include_dirs: Array.isArray(conduitBoundary.include_dirs)
        ? conduitBoundary.include_dirs
        : base.conduit_boundary.include_dirs,
      include_ext: Array.isArray(conduitBoundary.include_ext)
        ? conduitBoundary.include_ext
        : base.conduit_boundary.include_ext,
      exclude_contains: Array.isArray(conduitBoundary.exclude_contains)
        ? conduitBoundary.exclude_contains
        : base.conduit_boundary.exclude_contains,
      allowlisted_files: Array.isArray(conduitBoundary.allowlisted_files)
        ? conduitBoundary.allowlisted_files
        : base.conduit_boundary.allowlisted_files,
      forbidden_patterns: Array.isArray(conduitBoundary.forbidden_patterns)
        ? conduitBoundary.forbidden_patterns
        : base.conduit_boundary.forbidden_patterns
    },
    scan: {
      include_dirs: Array.isArray(scan.include_dirs) ? scan.include_dirs : base.scan.include_dirs,
      include_ext: Array.isArray(scan.include_ext) ? scan.include_ext : base.scan.include_ext,
      exclude_contains: Array.isArray(scan.exclude_contains) ? scan.exclude_contains : base.scan.exclude_contains
    },
    paths: {
      latest_path: resolvePath(paths.latest_path, base.paths.latest_path),
      receipts_path: resolvePath(paths.receipts_path, base.paths.receipts_path)
    }
  };
}

function walkFiles(absDir: string, includeExt: string[], excludeContains: string[], out: string[]) {
  if (!fs.existsSync(absDir)) return;
  const entries = fs.readdirSync(absDir, { withFileTypes: true });
  for (const row of entries) {
    const abs = path.join(absDir, row.name);
    const relp = rel(abs);
    if (excludeContains.some((v: string) => relp.includes(v))) continue;
    if (row.isDirectory()) {
      walkFiles(abs, includeExt, excludeContains, out);
      continue;
    }
    if (!includeExt.includes(path.extname(row.name))) continue;
    out.push(abs);
  }
}

function resolveLayer(policy: AnyObj, relPath: string) {
  for (const [layer, prefixes] of Object.entries(policy.layers || {})) {
    if (!Array.isArray(prefixes)) continue;
    if (prefixes.some((prefix) => relPath === String(prefix) || relPath.startsWith(`${String(prefix).replace(/\/+$/, '')}/`))) {
      return String(layer);
    }
  }
  return null;
}

function parseImports(source: string) {
  const out: string[] = [];
  const importRe = /import\s+[^'"`]*?from\s*['"]([^'"`]+)['"]/g;
  const importSideRe = /import\s*['"]([^'"`]+)['"]/g;
  const requireRe = /require\(\s*['"]([^'"`]+)['"]\s*\)/g;

  for (const re of [importRe, importSideRe, requireRe]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(source)) != null) {
      const spec = cleanText(m[1], 320);
      if (!spec) continue;
      out.push(spec);
    }
  }
  return out;
}

function resolveTargetAbs(sourceFileAbs: string, spec: string) {
  if (!spec) return null;
  if (spec.startsWith('./') || spec.startsWith('../')) {
    return path.resolve(path.dirname(sourceFileAbs), spec);
  }
  if (spec.startsWith('/')) return spec;

  if (spec.startsWith('systems/') || spec.startsWith('lib/') || spec.startsWith('adaptive/') || spec.startsWith('habits/') || spec.startsWith('memory/') || spec.startsWith('tests/') || spec.startsWith('config/') || spec.startsWith('state/')) {
    return path.join(ROOT, spec);
  }
  return null;
}

function resolveTargetLayer(policy: AnyObj, sourceFileAbs: string, spec: string) {
  const abs = resolveTargetAbs(sourceFileAbs, spec);
  if (!abs) return null;

  const candidates = [abs, `${abs}.ts`, `${abs}.js`, path.join(abs, 'index.ts'), path.join(abs, 'index.js')];
  for (const row of candidates) {
    const relp = rel(row);
    const layer = resolveLayer(policy, relp);
    if (layer) return { layer, rel: relp };
  }

  return null;
}

function detectCycles(edges: Array<{ from: string; to: string }>) {
  const graph = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (!graph.has(edge.from)) graph.set(edge.from, new Set());
    graph.get(edge.from)!.add(edge.to);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const cycles: string[] = [];

  function dfs(node: string) {
    if (visiting.has(node)) {
      const idx = stack.lastIndexOf(node);
      const cycle = idx >= 0 ? stack.slice(idx).concat(node) : [node, node];
      cycles.push(cycle.join(' -> '));
      return;
    }
    if (visited.has(node)) return;
    visiting.add(node);
    stack.push(node);
    for (const next of graph.get(node) || []) dfs(next);
    stack.pop();
    visiting.delete(node);
    visited.add(node);
  }

  for (const node of graph.keys()) dfs(node);
  return Array.from(new Set(cycles));
}

function runCheck(policy: AnyObj, strict: boolean) {
  const enforceLayerSet = new Set((policy.enforce_layers || []).map((v: string) => String(v)));
  const enforceAllLayers = enforceLayerSet.size === 0;

  const files: string[] = [];
  for (const dirRel of policy.scan.include_dirs) {
    walkFiles(path.join(ROOT, String(dirRel)), policy.scan.include_ext, policy.scan.exclude_contains, files);
  }

  const violations: AnyObj[] = [];
  const conduitViolations: AnyObj[] = [];
  const edges: Array<{ from: string; to: string }> = [];
  const unresolvedImports: AnyObj[] = [];

  for (const fileAbs of files) {
    const fileRel = rel(fileAbs);
    const sourceLayer = resolveLayer(policy, fileRel);
    if (!sourceLayer) continue;
    const source = fs.readFileSync(fileAbs, 'utf8');
    const specs = parseImports(source);
    for (const spec of specs) {
      const target = resolveTargetLayer(policy, fileAbs, spec);
      if (!target) {
        unresolvedImports.push({ file: fileRel, import: spec });
        continue;
      }

      if (target.layer !== sourceLayer) {
        edges.push({ from: sourceLayer, to: target.layer });
      }

      if (!enforceAllLayers && !enforceLayerSet.has(sourceLayer)) continue;
      const allowed = Array.isArray(policy.allow_imports[sourceLayer]) ? policy.allow_imports[sourceLayer] : [];
      if (!allowed.includes(target.layer)) {
        violations.push({
          file: fileRel,
          import: spec,
          from_layer: sourceLayer,
          to_layer: target.layer,
          to_path: target.rel
        });
      }
    }
  }

  if (policy.conduit_boundary && policy.conduit_boundary.enabled === true) {
    const boundaryFiles: string[] = [];
    for (const dirRel of policy.conduit_boundary.include_dirs || []) {
      walkFiles(
        path.join(ROOT, String(dirRel)),
        policy.conduit_boundary.include_ext || ['.ts', '.js'],
        policy.conduit_boundary.exclude_contains || [],
        boundaryFiles
      );
    }
    const allowlisted = new Set(
      (policy.conduit_boundary.allowlisted_files || [])
        .map((v: unknown) => String(v || '').replace(/\\/g, '/'))
        .filter(Boolean)
    );
    const patterns = (policy.conduit_boundary.forbidden_patterns || [])
      .map((v: unknown) => cleanText(v, 200))
      .filter(Boolean);

    for (const fileAbs of boundaryFiles) {
      const fileRel = rel(fileAbs);
      if (allowlisted.has(fileRel)) continue;
      const source = fs.readFileSync(fileAbs, 'utf8');
      for (const pattern of patterns) {
        if (!source.includes(pattern)) continue;
        conduitViolations.push({
          file: fileRel,
          type: 'direct_core_transfer_pattern',
          pattern
        });
      }
    }
  }

  const cycleEdges = policy.enforce_cycles === true && !enforceAllLayers
    ? edges.filter((edge) => enforceLayerSet.has(edge.from) && enforceLayerSet.has(edge.to))
    : edges;
  const cycles = policy.enforce_cycles === true ? detectCycles(cycleEdges) : [];

  const checks = {
    no_boundary_violations: violations.length === 0,
    conduit_only_boundary: conduitViolations.length === 0,
    no_layer_cycles: cycles.length === 0,
    scanned_files_found: files.length > 0
  };
  const blocking = Object.entries(checks).filter(([, ok]) => ok !== true).map(([k]) => k);
  const pass = blocking.length === 0;
  const ok = strict ? pass : true;

  const out = {
    ok,
    pass,
    strict,
    type: 'dependency_boundary_guard',
    ts: nowIso(),
    checks,
    blocking_checks: blocking,
    counts: {
      files: files.length,
      violations: violations.length,
      conduit_violations: conduitViolations.length,
      cycles: cycles.length,
      unresolved_imports: unresolvedImports.length
    },
    enforcement: {
      enforce_layers: Array.from(enforceLayerSet),
      enforce_cycles: policy.enforce_cycles === true
    },
    violations: violations.slice(0, 200),
    conduit_violations: conduitViolations.slice(0, 400),
    cycles,
    unresolved_imports: unresolvedImports.slice(0, 200)
  };

  writeJsonAtomic(policy.paths.latest_path, out);
  appendJsonl(policy.paths.receipts_path, out);
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || 'check').toLowerCase();
  if (args.help || cmd === '--help' || cmd === 'help') {
    usage();
    return emit({ ok: true, help: true }, 0);
  }

  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);

  if (cmd === 'status') {
    return emit(readJson(policy.paths.latest_path, {
      ok: true,
      type: 'dependency_boundary_guard',
      status: 'no_status'
    }), 0);
  }

  if (cmd !== 'check') {
    usage();
    return emit({ ok: false, error: `unknown_command:${cmd}` }, 1);
  }

  const strict = toBool(args.strict, true);
  const out = runCheck(policy, strict);
  return emit(out, out.ok ? 0 : 1);
}

main();
