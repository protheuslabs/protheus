#!/usr/bin/env node
'use strict';
export {};

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

type AnyObj = Record<string, any>;

const ROOT = process.env.CONFIG_REGISTRY_ROOT
  ? path.resolve(process.env.CONFIG_REGISTRY_ROOT)
  : path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = process.env.CONFIG_REGISTRY_POLICY_PATH
  ? path.resolve(process.env.CONFIG_REGISTRY_POLICY_PATH)
  : path.join(ROOT, 'config', 'config_registry_policy.json');

function nowIso(): string {
  return new Date().toISOString();
}

function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath: string, fallback: AnyObj = {}): AnyObj {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath: string, value: AnyObj): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function appendJsonl(filePath: string, value: AnyObj): void {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, 'utf8');
}

function cleanText(v: unknown, maxLen = 180): string {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function clampInt(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

function normalizeList(v: unknown): string[] {
  if (Array.isArray(v)) return Array.from(new Set(v.map((x) => String(x || '').trim()).filter(Boolean)));
  const raw = String(v || '').trim();
  if (!raw) return [];
  return Array.from(new Set(raw.split(',').map((x) => String(x || '').trim()).filter(Boolean)));
}

function parseArgs(argv: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (const tok of argv) {
    const raw = String(tok || '').trim();
    if (!raw) continue;
    if (!raw.startsWith('--')) {
      positional.push(raw);
      continue;
    }
    const idx = raw.indexOf('=');
    if (idx === -1) flags[raw.slice(2)] = '1';
    else flags[raw.slice(2, idx)] = raw.slice(idx + 1);
  }
  return { positional, flags };
}

function hashText(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function listFiles(rootPath: string, includeExts: Set<string>, excludes: string[], maxFiles: number): string[] {
  const out: string[] = [];
  if (!fs.existsSync(rootPath)) return out;
  const walk = (dirPath: string): void => {
    if (out.length >= maxFiles) return;
    for (const ent of fs.readdirSync(dirPath, { withFileTypes: true })) {
      if (out.length >= maxFiles) return;
      const full = path.join(dirPath, ent.name);
      const posix = full.replace(/\\/g, '/');
      if (excludes.some((needle) => needle && posix.includes(needle))) continue;
      if (ent.isDirectory()) {
        walk(full);
      } else if (ent.isFile()) {
        const ext = path.extname(ent.name).toLowerCase();
        if (!includeExts.has(ext)) continue;
        out.push(full);
      }
    }
  };
  walk(rootPath);
  return out;
}

function rel(filePath: string): string {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function inferTypeTag(filePath: string, topKeys: string[]): string {
  const p = rel(filePath).toLowerCase();
  if (p.includes('/strategies/')) return 'strategy_profile';
  if (p.includes('policy')) return 'policy';
  if (p.includes('map')) return 'mapping';
  if (p.includes('rules')) return 'ruleset';
  if (topKeys.includes('routing') || topKeys.includes('spawn_model_allowlist')) return 'routing';
  if (topKeys.includes('sinks') || topKeys.includes('alert_routing')) return 'observability';
  return 'config';
}

function collectShape(value: unknown, prefix: string, depth: number, maxDepth: number, out: string[]): void {
  if (depth > maxDepth) return;
  if (Array.isArray(value)) {
    out.push(`${prefix}[]`);
    if (value.length > 0) collectShape(value[0], `${prefix}[]`, depth + 1, maxDepth, out);
    return;
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value as AnyObj).sort();
    for (const key of keys) {
      const next = prefix ? `${prefix}.${key}` : key;
      const row = (value as AnyObj)[key];
      const type = Array.isArray(row) ? 'array' : (row === null ? 'null' : typeof row);
      out.push(`${next}:${type}`);
      collectShape(row, next, depth + 1, maxDepth, out);
    }
    return;
  }
}

function loadPolicy(policyPath: string): AnyObj {
  const base = {
    version: '1.0',
    enabled: true,
    scan_roots: ['config'],
    include_extensions: ['.json'],
    exclude_path_substrings: ['/node_modules/', '/.git/', '/dist/'],
    shape_depth: 3,
    max_files: 4000,
    inventory_output_path: 'state/ops/config_registry/latest.json',
    inventory_history_jsonl_path: 'state/ops/config_registry/history.jsonl',
    consolidation: {
      enabled: true,
      min_shape_group_size: 2,
      max_candidates: 80
    },
    legacy_aliases: {
      enabled: true,
      alias_map_path: 'config/config_aliases.json',
      strict_canonical_exists: true
    }
  };
  const raw = readJson(policyPath, {});
  const consolidation = raw && raw.consolidation && typeof raw.consolidation === 'object'
    ? raw.consolidation
    : {};
  const aliases = raw && raw.legacy_aliases && typeof raw.legacy_aliases === 'object'
    ? raw.legacy_aliases
    : {};
  return {
    version: cleanText(raw.version || base.version, 40) || '1.0',
    enabled: raw.enabled === false ? false : true,
    scan_roots: normalizeList(raw.scan_roots).length > 0 ? normalizeList(raw.scan_roots) : base.scan_roots,
    include_extensions: normalizeList(raw.include_extensions).length > 0 ? normalizeList(raw.include_extensions) : base.include_extensions,
    exclude_path_substrings: normalizeList(raw.exclude_path_substrings).length > 0
      ? normalizeList(raw.exclude_path_substrings)
      : base.exclude_path_substrings,
    shape_depth: clampInt(raw.shape_depth, 1, 8, base.shape_depth),
    max_files: clampInt(raw.max_files, 50, 100000, base.max_files),
    inventory_output_path: cleanText(raw.inventory_output_path || base.inventory_output_path, 220) || base.inventory_output_path,
    inventory_history_jsonl_path: cleanText(raw.inventory_history_jsonl_path || base.inventory_history_jsonl_path, 220) || base.inventory_history_jsonl_path,
    consolidation: {
      enabled: consolidation.enabled === false ? false : true,
      min_shape_group_size: clampInt(consolidation.min_shape_group_size, 2, 50, base.consolidation.min_shape_group_size),
      max_candidates: clampInt(consolidation.max_candidates, 1, 1000, base.consolidation.max_candidates)
    },
    legacy_aliases: {
      enabled: aliases.enabled === false ? false : true,
      alias_map_path: cleanText(aliases.alias_map_path || base.legacy_aliases.alias_map_path, 220) || base.legacy_aliases.alias_map_path,
      strict_canonical_exists: aliases.strict_canonical_exists === false ? false : true
    }
  };
}

function loadAliasMap(filePath: string): AnyObj[] {
  const raw = readJson(filePath, {});
  const aliases = Array.isArray(raw.aliases) ? raw.aliases : [];
  return aliases
    .map((row) => ({
      alias: cleanText(row && row.alias, 260),
      canonical: cleanText(row && row.canonical, 260),
      mode: cleanText(row && row.mode, 24).toLowerCase() || 'copy'
    }))
    .filter((row) => row.alias && row.canonical && row.mode === 'copy');
}

function syncAliases(aliasRows: AnyObj[], strictCanonical: boolean): AnyObj {
  let synced = 0;
  let skipped = 0;
  const samples: AnyObj[] = [];
  for (const row of aliasRows) {
    const canonicalPath = path.resolve(ROOT, row.canonical);
    const aliasPath = path.resolve(ROOT, row.alias);
    if (!fs.existsSync(canonicalPath)) {
      skipped += 1;
      if (samples.length < 12) samples.push({ alias: row.alias, canonical: row.canonical, synced: false, reason: 'canonical_missing' });
      if (strictCanonical) continue;
      continue;
    }
    const canonicalBody = fs.readFileSync(canonicalPath, 'utf8');
    const existingBody = fs.existsSync(aliasPath) ? fs.readFileSync(aliasPath, 'utf8') : '';
    if (existingBody === canonicalBody) {
      skipped += 1;
      if (samples.length < 12) samples.push({ alias: row.alias, canonical: row.canonical, synced: false, reason: 'already_in_sync' });
      continue;
    }
    ensureDir(path.dirname(aliasPath));
    fs.writeFileSync(aliasPath, canonicalBody, 'utf8');
    synced += 1;
    if (samples.length < 12) samples.push({ alias: row.alias, canonical: row.canonical, synced: true });
  }
  return { synced, skipped, samples };
}

function buildInventory(policy: AnyObj): AnyObj {
  const roots = policy.scan_roots.map((p: string) => path.resolve(ROOT, p));
  const includeExts = new Set(policy.include_extensions.map((ext: string) => {
    const lower = String(ext || '').toLowerCase();
    return lower.startsWith('.') ? lower : `.${lower}`;
  }));
  const excludes = policy.exclude_path_substrings;
  const files = Array.from(new Set(
    roots.flatMap((rootPath: string) => listFiles(rootPath, includeExts, excludes, Number(policy.max_files || 4000)))
  )).sort();

  const rows: AnyObj[] = [];
  const parseErrors: AnyObj[] = [];
  const groups: Record<string, AnyObj[]> = {};
  for (const filePath of files) {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      continue;
    }
    const relPath = rel(filePath);
    const body = fs.readFileSync(filePath, 'utf8');
    const sha256 = hashText(body);
    const row: AnyObj = {
      path: relPath,
      bytes: Number(stat.size || 0),
      mtime_ts: stat.mtime.toISOString(),
      sha256
    };
    try {
      const parsed = JSON.parse(body);
      const topKeys = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? Object.keys(parsed).sort()
        : [];
      const shapeRows: string[] = [];
      collectShape(parsed, '', 1, Number(policy.shape_depth || 3), shapeRows);
      const shapeFingerprint = hashText(shapeRows.sort().join('|')).slice(0, 16);
      row.type_tag = inferTypeTag(filePath, topKeys);
      row.top_level_keys = topKeys.slice(0, 32);
      row.shape_fingerprint = shapeFingerprint;
      row.valid_json = true;
      (groups[shapeFingerprint] = groups[shapeFingerprint] || []).push(row);
    } catch (err: any) {
      row.type_tag = 'invalid_json';
      row.top_level_keys = [];
      row.shape_fingerprint = null;
      row.valid_json = false;
      row.parse_error = cleanText(err && err.message ? err.message : err, 200) || 'invalid_json';
      parseErrors.push({ path: relPath, error: row.parse_error });
    }
    rows.push(row);
  }

  const minGroupSize = Number(policy.consolidation.min_shape_group_size || 2);
  const maxCandidates = Number(policy.consolidation.max_candidates || 80);
  const consolidationCandidates = Object.values(groups)
    .filter((group) => group.length >= minGroupSize)
    .sort((a, b) => b.length - a.length)
    .slice(0, maxCandidates)
    .map((group) => {
      const ordered = [...group].sort((a, b) => {
        if (a.bytes !== b.bytes) return a.bytes - b.bytes;
        return String(a.path).localeCompare(String(b.path));
      });
      return {
        shape_fingerprint: ordered[0].shape_fingerprint,
        count: ordered.length,
        canonical_candidate: ordered[0].path,
        files: ordered.map((row) => row.path)
      };
    });

  const validRows = rows.filter((row) => row.valid_json === true);
  return {
    files_scanned: rows.length,
    valid_json_files: validRows.length,
    invalid_json_files: parseErrors.length,
    type_counts: validRows.reduce((acc: Record<string, number>, row) => {
      const key = String(row.type_tag || 'unknown');
      acc[key] = Number(acc[key] || 0) + 1;
      return acc;
    }, {}),
    unique_shape_fingerprints: new Set(validRows.map((row) => row.shape_fingerprint)).size,
    parse_errors: parseErrors,
    consolidation_candidates: policy.consolidation.enabled ? consolidationCandidates : [],
    inventory: rows
  };
}

function runCmd(policyPath: string, applyAliases: boolean): void {
  const policy = loadPolicy(policyPath);
  if (policy.enabled === false) {
    const out = {
      ok: true,
      type: 'config_registry',
      ts: nowIso(),
      skipped: true,
      reason: 'disabled',
      policy_path: rel(policyPath)
    };
    writeJson(path.resolve(ROOT, policy.inventory_output_path), out);
    process.stdout.write(`${JSON.stringify(out)}\n`);
    return;
  }

  const inventory = buildInventory(policy);
  const aliasMapPath = path.resolve(ROOT, policy.legacy_aliases.alias_map_path);
  const aliasRows = policy.legacy_aliases.enabled ? loadAliasMap(aliasMapPath) : [];
  const aliasSync = applyAliases && policy.legacy_aliases.enabled
    ? syncAliases(aliasRows, policy.legacy_aliases.strict_canonical_exists !== false)
    : { synced: 0, skipped: aliasRows.length, samples: [] };
  const out = {
    ok: true,
    type: 'config_registry',
    ts: nowIso(),
    policy_path: rel(policyPath),
    apply_aliases: applyAliases,
    alias_map_path: rel(aliasMapPath),
    aliases_total: aliasRows.length,
    alias_sync: aliasSync,
    metrics: {
      files_scanned: Number(inventory.files_scanned || 0),
      valid_json_files: Number(inventory.valid_json_files || 0),
      invalid_json_files: Number(inventory.invalid_json_files || 0),
      unique_shape_fingerprints: Number(inventory.unique_shape_fingerprints || 0),
      consolidation_candidate_groups: Array.isArray(inventory.consolidation_candidates)
        ? inventory.consolidation_candidates.length
        : 0
    },
    type_counts: inventory.type_counts,
    parse_errors: inventory.parse_errors,
    consolidation_candidates: inventory.consolidation_candidates,
    inventory: inventory.inventory
  };
  const latestPath = path.resolve(ROOT, policy.inventory_output_path);
  const historyPath = path.resolve(ROOT, policy.inventory_history_jsonl_path);
  writeJson(latestPath, out);
  appendJsonl(historyPath, {
    ts: out.ts,
    type: out.type,
    policy_path: out.policy_path,
    apply_aliases: out.apply_aliases,
    aliases_total: out.aliases_total,
    alias_sync: out.alias_sync,
    metrics: out.metrics
  });
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

function statusCmd(policyPath: string): void {
  const policy = loadPolicy(policyPath);
  const latestPath = path.resolve(ROOT, policy.inventory_output_path);
  const latest = readJson(latestPath, {});
  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'config_registry_status',
    ts: nowIso(),
    policy_path: rel(policyPath),
    latest
  })}\n`);
}

function usage(): void {
  console.log('Usage:');
  console.log('  node systems/ops/config_registry.js run [--apply-aliases=0|1] [--policy=/abs/path.json]');
  console.log('  node systems/ops/config_registry.js status [--policy=/abs/path.json]');
}

function main(): void {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const cmd = String(positional[0] || '').trim().toLowerCase();
  const policyPath = flags.policy ? path.resolve(flags.policy) : DEFAULT_POLICY_PATH;
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    usage();
    return;
  }
  if (cmd === 'run') {
    const applyAliases = String(flags['apply-aliases'] || '0') === '1';
    runCmd(policyPath, applyAliases);
    return;
  }
  if (cmd === 'status') {
    statusCmd(policyPath);
    return;
  }
  usage();
  process.exit(2);
}

if (require.main === module) main();
