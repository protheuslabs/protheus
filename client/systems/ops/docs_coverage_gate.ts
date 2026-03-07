#!/usr/bin/env node
'use strict';

/**
 * docs_coverage_gate.js
 *
 * Docs-as-code gate:
 * - Ensures critical-path code changes map to required docs.
 * - Detects broken local markdown links under docs/.
 *
 * Usage:
 *   node systems/ops/docs_coverage_gate.js run [--base=HEAD~1] [--head=HEAD] [--files=a,b] [--require-touched=1|0] [--strict=1|0]
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const MAP_PATH = process.env.DOCS_COVERAGE_MAP_PATH
  ? path.resolve(process.env.DOCS_COVERAGE_MAP_PATH)
  : path.join(ROOT, 'config', 'docs_coverage_map.json');
const DOCS_ROOT = process.env.DOCS_COVERAGE_DOCS_ROOT
  ? path.resolve(process.env.DOCS_COVERAGE_DOCS_ROOT)
  : path.join(ROOT, 'docs');

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/docs_coverage_gate.js run [--base=HEAD~1] [--head=HEAD] [--files=a,b] [--require-touched=1|0] [--strict=1|0]');
}

function parseArgs(argv) {
  const out = { _: [] } as Record<string, any>;
  for (const arg of argv) {
    if (!arg.startsWith('--')) {
      out._.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq === -1) out[arg.slice(2)] = true;
    else out[arg.slice(2, eq)] = arg.slice(eq + 1);
  }
  return out;
}

function nowIso() {
  return new Date().toISOString();
}

function toBool(v, fallback) {
  if (v == null) return fallback;
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  return fallback;
}

function normText(v, max = 240) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
}

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function runGit(args) {
  const r = spawnSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8'
  });
  if (r.status !== 0) return [];
  return String(r.stdout || '')
    .split('\n')
    .map((x) => normText(x, 400))
    .filter(Boolean);
}

function changedFiles(args) {
  const explicit = normText(args.files, 8000);
  if (explicit) {
    return explicit.split(',').map((x) => normText(x, 400)).filter(Boolean);
  }
  const base = normText(args.base, 64) || 'HEAD~1';
  const head = normText(args.head, 64) || 'HEAD';
  const diff = runGit(['diff', '--name-only', `${base}..${head}`]);
  if (diff.length > 0) return diff;
  return runGit(['status', '--porcelain'])
    .map((line) => normText(line.slice(3), 400))
    .filter(Boolean);
}

function loadMap() {
  const raw = readJson(MAP_PATH, {});
  const rows = Array.isArray(raw.critical_paths) ? raw.critical_paths : [];
  return {
    version: normText(raw.version || '1.0', 24),
    require_docs_touched: toBool(raw.require_docs_touched, false),
    critical_paths: rows
      .map((row) => ({
        path_prefix: normText(row && row.path_prefix, 200),
        required_docs: (Array.isArray(row && row.required_docs) ? row.required_docs : [])
          .map((doc) => normText(doc, 240))
          .filter(Boolean)
      }))
      .filter((row) => row.path_prefix && row.required_docs.length > 0)
  };
}

function matchRequiredDocs(changed, mapRows) {
  const critical = changed.filter((file) => mapRows.some((row) => file.startsWith(row.path_prefix)));
  const requiredSet = new Set<string>();
  const coverage = [] as Record<string, any>[];
  for (const file of critical) {
    const matched = mapRows.filter((row) => file.startsWith(row.path_prefix));
    const required = Array.from(new Set(matched.flatMap((row) => row.required_docs)));
    for (const doc of required) requiredSet.add(doc);
    coverage.push({ file, required_docs: required });
  }
  return {
    critical_changed: critical,
    required_docs: Array.from(requiredSet).sort(),
    coverage
  };
}

function docsExist(requiredDocs) {
  const missing = [] as string[];
  for (const rel of requiredDocs || []) {
    const fp = path.resolve(ROOT, rel);
    if (!fs.existsSync(fp)) missing.push(rel);
  }
  return missing;
}

function docFilesInDiff(changed) {
  return changed.filter((f) => f.startsWith('docs/') && f.endsWith('.md'));
}

function collectMarkdownFiles(dirPath, out) {
  if (!fs.existsSync(dirPath)) return;
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const e of entries) {
    if (!e) continue;
    const fp = path.join(dirPath, e.name);
    if (e.isDirectory()) {
      collectMarkdownFiles(fp, out);
      continue;
    }
    if (e.isFile() && e.name.toLowerCase().endsWith('.md')) out.push(fp);
  }
}

function localLinkBroken(srcPath, linkTarget) {
  const cleaned = normText(linkTarget, 600).replace(/#.*/, '').replace(/\?.*$/, '');
  if (!cleaned) return false;
  if (/^(https?:|mailto:|#)/i.test(cleaned)) return false;
  const resolved = path.resolve(path.dirname(srcPath), cleaned);
  return !fs.existsSync(resolved);
}

function scanBrokenLinks() {
  const mdFiles = [] as string[];
  collectMarkdownFiles(DOCS_ROOT, mdFiles);
  const broken = [] as Record<string, any>[];
  const linkRe = /\[[^\]]+\]\(([^)]+)\)/g;
  for (const fp of mdFiles) {
    const body = fs.readFileSync(fp, 'utf8');
    const lines = body.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      let m = null;
      while ((m = linkRe.exec(line)) !== null) {
        const target = String(m[1] || '').trim();
        if (!target) continue;
        if (localLinkBroken(fp, target)) {
          broken.push({
            file: path.relative(ROOT, fp),
            line: i + 1,
            link: target
          });
        }
      }
    }
  }
  return broken;
}

function cmdRun(args) {
  const map = loadMap();
  const strict = toBool(args.strict, true);
  const requireTouched = toBool(args['require-touched'], map.require_docs_touched);
  const changed = changedFiles(args);
  const matched = matchRequiredDocs(changed, map.critical_paths);
  const missingDocs = docsExist(matched.required_docs);
  const touchedDocs = docFilesInDiff(changed);
  const touchedRequiredDocs = matched.required_docs.filter((doc) => touchedDocs.includes(doc));
  const brokenLinks = scanBrokenLinks();
  const touchGatePass = !requireTouched || matched.required_docs.length === 0 || touchedRequiredDocs.length > 0;

  const out = {
    ok: missingDocs.length === 0 && brokenLinks.length === 0 && touchGatePass,
    type: 'docs_coverage_gate',
    ts: nowIso(),
    strict,
    map_version: map.version,
    require_docs_touched: requireTouched,
    changed_files_count: changed.length,
    critical_changed_count: matched.critical_changed.length,
    required_docs_count: matched.required_docs.length,
    gates: {
      docs_exist: missingDocs.length === 0,
      docs_touched: touchGatePass,
      local_links_valid: brokenLinks.length === 0
    },
    missing_docs: missingDocs,
    required_docs: matched.required_docs,
    touched_docs: touchedDocs,
    touched_required_docs: touchedRequiredDocs,
    broken_links: brokenLinks.slice(0, 200),
    coverage: matched.coverage.slice(0, 200),
    reasons: [
      missingDocs.length > 0 ? 'required_docs_missing' : null,
      !touchGatePass ? 'required_docs_not_touched' : null,
      brokenLinks.length > 0 ? 'broken_local_doc_links' : null
    ].filter(Boolean)
  };

  process.stdout.write(`${JSON.stringify(out)}\n`);
  if (strict && out.ok !== true) process.exitCode = 1;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normText(args._[0], 64).toLowerCase();
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    usage();
    return;
  }
  if (cmd === 'run') return cmdRun(args);
  usage();
  process.exitCode = 2;
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stdout.write(JSON.stringify({
      ok: false,
      error: String(err && err.message || err || 'docs_coverage_gate_failed')
    }) + '\n');
    process.exit(1);
  }
}

module.exports = {
  changedFiles,
  loadMap,
  scanBrokenLinks
};
export {};
