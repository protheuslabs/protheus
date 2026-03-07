#!/usr/bin/env node
'use strict';
export {};

const path = require('path');
const fs = require('fs');
const {
  ROOT,
  nowIso,
  parseArgs,
  readJson,
  emit
} = require('../../lib/queued_backlog_runtime');

const MAP_PATH = path.join(ROOT, 'core', 'memory', 'compat_map.json');

function usage() {
  console.log('Usage:');
  console.log('  node core/memory/compat_bridge.js status');
}

function rel(absPath: string) {
  return path.relative(ROOT, absPath).replace(/\\/g, '/');
}

function loadCompatMap() {
  const raw = readJson(MAP_PATH, {});
  const aliasRoot = String(raw.alias_root || 'core/memory').trim() || 'core/memory';
  const canonicalRoot = String(raw.canonical_root || 'systems/memory/rust').trim() || 'systems/memory/rust';
  const canonicalRuntime = String(raw.canonical_ts_runtime || 'systems/memory/memory_recall.ts').trim() || 'systems/memory/memory_recall.ts';
  const crateAliases = Array.isArray(raw.crate_name_aliases) ? raw.crate_name_aliases.map(String).filter(Boolean) : ['protheus-memory-core', 'protheus-memory'];
  return {
    schema_id: String(raw.schema_id || 'core_memory_path_compat_map'),
    schema_version: String(raw.schema_version || '1.0'),
    alias_root: aliasRoot,
    canonical_root: canonicalRoot,
    canonical_ts_runtime: canonicalRuntime,
    crate_name_aliases: crateAliases
  };
}

function status() {
  const map = loadCompatMap();
  const aliasAbs = path.join(ROOT, map.alias_root);
  const canonicalAbs = path.join(ROOT, map.canonical_root);
  const runtimeAbs = path.join(ROOT, map.canonical_ts_runtime);
  const cargoTomlAbs = path.join(canonicalAbs, 'Cargo.toml');
  const cargoRaw = fs.existsSync(cargoTomlAbs) ? fs.readFileSync(cargoTomlAbs, 'utf8') : '';
  const cargoName = (() => {
    const m = cargoRaw.match(/\nname\s*=\s*\"([^\"]+)\"/);
    return m ? String(m[1]) : null;
  })();

  emit({
    ok: true,
    type: 'core_memory_compat_status',
    ts: nowIso(),
    map,
    alias_exists: fs.existsSync(aliasAbs),
    canonical_exists: fs.existsSync(canonicalAbs),
    canonical_runtime_exists: fs.existsSync(runtimeAbs),
    cargo_toml_exists: fs.existsSync(cargoTomlAbs),
    cargo_package_name: cargoName,
    paths: {
      map_path: rel(MAP_PATH),
      alias_root: rel(aliasAbs),
      canonical_root: rel(canonicalAbs),
      canonical_runtime: rel(runtimeAbs),
      cargo_toml: rel(cargoTomlAbs)
    }
  });
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim();
  if (!cmd || args.help) {
    usage();
    process.exit(cmd ? 0 : 1);
  }
  if (cmd === 'status') return status();
  usage();
  process.exit(1);
}

main();
