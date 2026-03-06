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
  normalizeToken,
  toBool,
  readJson,
  writeJsonAtomic,
  appendJsonl,
  resolvePath,
  emit
} = require('../../lib/queued_backlog_runtime');

const POLICY_PATH = process.env.TYPE_DERIVED_LANE_DOCS_AUTOGEN_POLICY_PATH
  ? path.resolve(process.env.TYPE_DERIVED_LANE_DOCS_AUTOGEN_POLICY_PATH)
  : path.join(ROOT, 'config', 'type_derived_lane_docs_autogen_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/type_derived_lane_docs_autogen.js generate [--apply=1|0] [--strict=1|0] [--policy=<path>]');
  console.log('  node systems/ops/type_derived_lane_docs_autogen.js verify [--strict=1|0] [--policy=<path>]');
  console.log('  node systems/ops/type_derived_lane_docs_autogen.js rollback [--apply=1|0] [--policy=<path>]');
  console.log('  node systems/ops/type_derived_lane_docs_autogen.js status [--policy=<path>]');
}

function rel(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function workspaceRoot() {
  const envRoot = cleanText(process.env.OPENCLAW_WORKSPACE || '', 520);
  if (envRoot) return path.resolve(envRoot);
  return ROOT;
}

function walk(rootDir: string, out: string[] = []) {
  if (!fs.existsSync(rootDir)) return out;
  const entries = fs.readdirSync(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const abs = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      walk(abs, out);
    } else if (entry.isFile()) {
      out.push(abs);
    }
  }
  return out;
}

function collectRoots(raw: unknown, fallback: string[]) {
  const src = Array.isArray(raw) ? raw : fallback;
  return src.map((row: unknown) => cleanText(row, 260)).filter(Boolean);
}

function parseExportsFromTs(source: string) {
  const names = new Set<string>();
  const regex = /export\s+(?:async\s+)?(?:function|const|class|type|interface|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/g;
  for (const match of source.matchAll(regex)) names.add(match[1]);
  const braceRegex = /export\s*{\s*([^}]+)\s*}/g;
  for (const match of source.matchAll(braceRegex)) {
    const chunk = String(match[1] || '');
    chunk.split(',').forEach((token) => {
      const name = cleanText(token.split(/\s+as\s+/i)[0], 120);
      if (name) names.add(name);
    });
  }
  return Array.from(names).sort();
}

function parseExportsFromRust(source: string) {
  const names = new Set<string>();
  const regex = /pub\s+(?:async\s+)?(?:fn|struct|enum|trait|const|type)\s+([A-Za-z_][A-Za-z0-9_]*)/g;
  for (const match of source.matchAll(regex)) names.add(match[1]);
  return Array.from(names).sort();
}

function buildReferenceDoc(title: string, rows: Array<{ file: string, exports: string[] }>) {
  const lines = [`# ${title}`, '', 'Generated: deterministic', ''];
  if (!rows.length) {
    lines.push('_No exported symbols detected._', '');
    return lines.join('\n');
  }
  for (const row of rows) {
    lines.push(`## ${row.file}`, '');
    if (!row.exports.length) {
      lines.push('- _(none)_', '');
      continue;
    }
    for (const symbol of row.exports) {
      lines.push(`- \`${symbol}\``);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function loadPolicy(policyPath: string) {
  const raw = readJson(policyPath, {});
  const base = {
    version: '1.0',
    enabled: true,
    strict_default: true,
    ts_roots: ['systems', 'lib'],
    rust_roots: ['crates'],
    docs: {
      ts_reference_path: 'docs/generated/TS_LANE_TYPE_REFERENCE.md',
      rust_reference_path: 'docs/generated/RUST_LANE_TYPE_REFERENCE.md'
    },
    paths: {
      latest_path: 'state/ops/type_derived_lane_docs_autogen/latest.json',
      receipts_path: 'state/ops/type_derived_lane_docs_autogen/receipts.jsonl',
      snapshots_root: 'state/ops/type_derived_lane_docs_autogen/snapshots'
    }
  };
  const merged = { ...base, ...(raw && typeof raw === 'object' ? raw : {}) };
  const docs = merged.docs && typeof merged.docs === 'object' ? merged.docs : {};
  const outPaths = merged.paths && typeof merged.paths === 'object' ? merged.paths : {};
  const ws = workspaceRoot();
  return {
    ...merged,
    ts_roots: collectRoots(merged.ts_roots, base.ts_roots).map((row: string) => path.resolve(ws, row)),
    rust_roots: collectRoots(merged.rust_roots, base.rust_roots).map((row: string) => path.resolve(ws, row)),
    docs: {
      ts_reference_path: path.resolve(ws, cleanText(docs.ts_reference_path, 260) || base.docs.ts_reference_path),
      rust_reference_path: path.resolve(ws, cleanText(docs.rust_reference_path, 260) || base.docs.rust_reference_path)
    },
    paths: {
      latest_path: resolvePath(outPaths.latest_path, base.paths.latest_path),
      receipts_path: resolvePath(outPaths.receipts_path, base.paths.receipts_path),
      snapshots_root: resolvePath(outPaths.snapshots_root, base.paths.snapshots_root)
    },
    policy_path: path.resolve(policyPath)
  };
}

function computeDocs(policy: any) {
  const tsRows: Array<{ file: string, exports: string[] }> = [];
  for (const root of policy.ts_roots) {
    for (const abs of walk(root)) {
      if (!abs.endsWith('.ts')) continue;
      const exports = parseExportsFromTs(String(fs.readFileSync(abs, 'utf8') || ''));
      tsRows.push({ file: path.relative(workspaceRoot(), abs).replace(/\\/g, '/'), exports });
    }
  }
  tsRows.sort((a, b) => a.file.localeCompare(b.file));

  const rustRows: Array<{ file: string, exports: string[] }> = [];
  for (const root of policy.rust_roots) {
    for (const abs of walk(root)) {
      if (!abs.endsWith('.rs')) continue;
      const exports = parseExportsFromRust(String(fs.readFileSync(abs, 'utf8') || ''));
      rustRows.push({ file: path.relative(workspaceRoot(), abs).replace(/\\/g, '/'), exports });
    }
  }
  rustRows.sort((a, b) => a.file.localeCompare(b.file));

  return {
    ts_doc: buildReferenceDoc('TS Lane Type Reference', tsRows),
    rust_doc: buildReferenceDoc('Rust Lane Type Reference', rustRows)
  };
}

function writeDocs(policy: any, docs: any) {
  fs.mkdirSync(path.dirname(policy.docs.ts_reference_path), { recursive: true });
  fs.mkdirSync(path.dirname(policy.docs.rust_reference_path), { recursive: true });
  fs.writeFileSync(policy.docs.ts_reference_path, `${docs.ts_doc}\n`, 'utf8');
  fs.writeFileSync(policy.docs.rust_reference_path, `${docs.rust_doc}\n`, 'utf8');
}

function snapshotDocs(policy: any) {
  fs.mkdirSync(policy.paths.snapshots_root, { recursive: true });
  const stamp = nowIso().replace(/[:.]/g, '-');
  const snapDir = path.join(policy.paths.snapshots_root, stamp);
  fs.mkdirSync(snapDir, { recursive: true });
  fs.copyFileSync(policy.docs.ts_reference_path, path.join(snapDir, 'TS_LANE_TYPE_REFERENCE.md'));
  fs.copyFileSync(policy.docs.rust_reference_path, path.join(snapDir, 'RUST_LANE_TYPE_REFERENCE.md'));
  return snapDir;
}

function persist(policy: any, row: any, apply: boolean) {
  if (!apply) return;
  writeJsonAtomic(policy.paths.latest_path, row);
  appendJsonl(policy.paths.receipts_path, row);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || 'status', 80) || 'status';
  if (args.help || cmd === 'help') {
    usage();
    emit({ ok: true, type: 'type_derived_lane_docs_autogen_help' }, 0);
  }
  const policyPath = args.policy ? path.resolve(String(args.policy)) : POLICY_PATH;
  const policy = loadPolicy(policyPath);
  const strict = toBool(args.strict, policy.strict_default);
  const apply = toBool(args.apply, true);
  if (policy.enabled === false) {
    emit({ ok: false, type: 'type_derived_lane_docs_autogen_error', error: 'lane_disabled' }, 2);
  }

  if (cmd === 'status') {
    emit({
      ok: true,
      type: 'type_derived_lane_docs_autogen_status',
      ts: nowIso(),
      latest: readJson(policy.paths.latest_path, {}),
      policy_path: rel(policy.policy_path)
    }, 0);
  }

  if (cmd === 'generate') {
    const docs = computeDocs(policy);
    if (apply) writeDocs(policy, docs);
    let snapshotPath = null;
    if (apply) snapshotPath = snapshotDocs(policy);
    const row = {
      ok: true,
      type: 'type_derived_lane_docs_autogen_generate',
      ts: nowIso(),
      strict,
      apply,
      snapshot_path: snapshotPath ? rel(snapshotPath) : null,
      policy_path: rel(policy.policy_path)
    };
    persist(policy, row, apply);
    emit(row, 0);
  }

  if (cmd === 'verify') {
    const docs = computeDocs(policy);
    const currentTs = fs.existsSync(policy.docs.ts_reference_path) ? fs.readFileSync(policy.docs.ts_reference_path, 'utf8') : '';
    const currentRust = fs.existsSync(policy.docs.rust_reference_path) ? fs.readFileSync(policy.docs.rust_reference_path, 'utf8') : '';
    const pass = currentTs.trim() === docs.ts_doc.trim() && currentRust.trim() === docs.rust_doc.trim();
    const row = {
      ok: pass,
      pass,
      type: 'type_derived_lane_docs_autogen_verify',
      ts: nowIso(),
      strict,
      apply,
      policy_path: rel(policy.policy_path)
    };
    persist(policy, row, apply);
    emit(row, pass || !strict ? 0 : 1);
  }

  if (cmd === 'rollback') {
    const root = policy.paths.snapshots_root;
    const dirs = fs.existsSync(root)
      ? fs.readdirSync(root).map((name: string) => path.join(root, name)).filter((abs: string) => fs.statSync(abs).isDirectory()).sort()
      : [];
    if (!dirs.length) {
      emit({ ok: false, type: 'type_derived_lane_docs_autogen_rollback', error: 'no_snapshots' }, 1);
    }
    const latest = dirs[dirs.length - 1];
    if (apply) {
      fs.copyFileSync(path.join(latest, 'TS_LANE_TYPE_REFERENCE.md'), policy.docs.ts_reference_path);
      fs.copyFileSync(path.join(latest, 'RUST_LANE_TYPE_REFERENCE.md'), policy.docs.rust_reference_path);
    }
    const row = {
      ok: true,
      type: 'type_derived_lane_docs_autogen_rollback',
      ts: nowIso(),
      strict,
      apply,
      restored_snapshot: rel(latest),
      policy_path: rel(policy.policy_path)
    };
    persist(policy, row, apply);
    emit(row, 0);
  }

  emit({ ok: false, type: 'type_derived_lane_docs_autogen_error', error: 'unsupported_command', cmd }, 2);
}

main();
