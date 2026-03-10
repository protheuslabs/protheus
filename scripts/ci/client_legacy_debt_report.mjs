#!/usr/bin/env node
/* eslint-disable no-console */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const ROOT = process.cwd();
const LEGACY_RE = /\.(js|py|sh|ps1)$/;
const SOURCE_CACHE = new Map();

function parseArgs(argv) {
  const out = {
    out: '',
    root: 'client',
  };
  for (const arg of argv) {
    if (arg.startsWith('--out=')) out.out = arg.slice('--out='.length);
    else if (arg.startsWith('--root=')) out.root = arg.slice('--root='.length);
  }
  return out;
}

function rel(p) {
  return path.relative(ROOT, p).replace(/\\/g, '/');
}

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (abs.includes('/runtime/local/')) continue;
      if (fs.existsSync(path.join(abs, '.git'))) continue;
      walk(abs, out);
      continue;
    }
    if (LEGACY_RE.test(ent.name)) out.push(abs);
  }
  return out;
}

function readSource(file) {
  if (SOURCE_CACHE.has(file)) return SOURCE_CACHE.get(file);
  let source = '';
  try {
    source = fs.readFileSync(path.resolve(ROOT, file), 'utf8');
  } catch {}
  SOURCE_CACHE.set(file, source);
  return source;
}

function isRuntimeWrapper(file) {
  if (!(file.startsWith('client/runtime/systems/') || file.startsWith('client/systems/'))) return false;
  if (path.extname(file).toLowerCase() !== '.js') return false;
  const source = readSource(file);
  if (!source) return false;
  return [
    'ts_bootstrap',
    'ts_entrypoint',
    'createOpsLaneBridge',
    'createLegacyRetiredModule',
    'createManifestLaneBridge',
    'createConduitLaneModule',
    'createRustLaneBridge',
    'createDirectConduitBridge',
    'createConduitBridge',
    'legacy-retired-lane',
    'Layer ownership: core/'
  ].some((marker) => source.includes(marker));
}

function classify(file) {
  if (file.startsWith('client/cli/apps/')) return 'move_to_apps';
  if (file.includes('/tests/')) return 'move_to_tests';
  if (file.startsWith('client/runtime/state/')) return 'tracked_state_debt';
  if (file.startsWith('client/runtime/tmp/')) return 'tmp_generated_debt';
  if (file.startsWith('client/runtime/patches/')) return 'platform_patch_surface';
  if (file.startsWith('client/install.') || file.startsWith('client/runtime/deploy/') || file.startsWith('client/cli/bin/') || file.startsWith('client/cli/npm/') || file.startsWith('client/cli/tools/')) return 'installer_or_dev_shell';
  if (file.startsWith('client/cognition/skills/')) return 'skill_script_or_connector';
  if (isRuntimeWrapper(file)) return 'runtime_wrapper_debt';
  if (file.startsWith('client/runtime/systems/') || file.startsWith('client/systems/')) return 'runtime_or_authority_debt';
  if (file.startsWith('client/runtime/lib/') || file.startsWith('client/lib/')) return 'platform_shim_debt';
  if (file.startsWith('client/memory/tools/')) return 'tooling_or_test_debt';
  if (file.startsWith('client/cognition/')) return 'cognition_surface_debt';
  return 'unclassified';
}

function countBy(items, keyFn) {
  const counts = {};
  for (const item of items) {
    const key = keyFn(item);
    counts[key] = (counts[key] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const rootDir = path.resolve(ROOT, args.root);
  const files = walk(rootDir).map(rel).sort();

  let revision = 'unknown';
  try {
    revision = execSync('git rev-parse HEAD', { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {}

  const entries = files.map((file) => ({
    file,
    ext: path.extname(file).replace(/^\./, ''),
    category: classify(file),
  }));

  const payload = {
    type: 'client_legacy_debt_report',
    generated_at: new Date().toISOString(),
    revision,
    root: rel(rootDir),
    summary: {
      total_files: entries.length,
      by_ext: countBy(entries, (entry) => entry.ext),
      by_category: countBy(entries, (entry) => entry.category),
    },
    entries,
  };

  if (args.out) {
    const outPath = path.resolve(ROOT, args.out);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);
  }

  console.log(JSON.stringify(payload, null, 2));
}

main();
