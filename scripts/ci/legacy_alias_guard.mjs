#!/usr/bin/env node
import { readFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const repoRoot = process.cwd();
const systemsRoot = path.join(repoRoot, 'client', 'runtime', 'systems');
const allowlistPath = path.join(
  repoRoot,
  'client',
  'runtime',
  'config',
  'legacy_alias_guard_allowlist.json',
);
const outDefault = path.join(repoRoot, 'core', 'local', 'artifacts', 'legacy_alias_guard_current.json');

function parseArgs(argv) {
  const out = { strict: false, out: outDefault };
  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] || '').trim();
    if (!token) continue;
    if (token === '--strict') {
      out.strict = true;
      continue;
    }
    if (token.startsWith('--strict=')) {
      const v = token.slice('--strict='.length).toLowerCase();
      out.strict = ['1', 'true', 'yes', 'on'].includes(v);
      continue;
    }
    if (token === '--out' && argv[i + 1]) {
      out.out = path.resolve(repoRoot, String(argv[i + 1]));
      i += 1;
      continue;
    }
    if (token.startsWith('--out=')) {
      out.out = path.resolve(repoRoot, token.slice('--out='.length));
      continue;
    }
  }
  return out;
}

function listFiles(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const abs = path.join(dir, entry);
    const st = statSync(abs);
    if (st.isDirectory()) {
      listFiles(abs, out);
      continue;
    }
    if (st.isFile() && abs.endsWith('.ts')) out.push(abs);
  }
  return out;
}

function loadAllowlist() {
  if (!existsSync(allowlistPath)) {
    return {
      allow_run_legacy_alias: [],
      allow_legacy_retired_lane: []
    };
  }
  try {
    const parsed = JSON.parse(readFileSync(allowlistPath, 'utf8'));
    return {
      allow_run_legacy_alias: Array.isArray(parsed.allow_run_legacy_alias)
        ? parsed.allow_run_legacy_alias.map((v) => String(v))
        : [],
      allow_legacy_retired_lane: Array.isArray(parsed.allow_legacy_retired_lane)
        ? parsed.allow_legacy_retired_lane.map((v) => String(v))
        : []
    };
  } catch {
    return {
      allow_run_legacy_alias: [],
      allow_legacy_retired_lane: []
    };
  }
}

function rel(abs) {
  return path.relative(repoRoot, abs).replace(/\\/g, '/');
}

const cfg = parseArgs(process.argv.slice(2));
const allowlist = loadAllowlist();
const files = listFiles(systemsRoot).sort();
const violations = [];

for (const file of files) {
  const relPath = rel(file);
  const raw = readFileSync(file, 'utf8');

  if (raw.includes('runLegacyAlias(') && !allowlist.allow_run_legacy_alias.includes(relPath)) {
    violations.push({
      type: 'run_legacy_alias_forbidden',
      file: relPath
    });
  }

  if (raw.includes('alias_rel:')) {
    violations.push({
      type: 'alias_rel_forbidden',
      file: relPath
    });
  }

  if (
    raw.includes('legacy-retired-lane')
    && !allowlist.allow_legacy_retired_lane.includes(relPath)
  ) {
    violations.push({
      type: 'legacy_retired_lane_route_forbidden',
      file: relPath
    });
  }
}

const report = {
  ok: violations.length === 0,
  type: 'legacy_alias_guard_report',
  strict: cfg.strict,
  scanned_files: files.length,
  allowlist,
  violation_count: violations.length,
  violations
};

mkdirSync(path.dirname(cfg.out), { recursive: true });
writeFileSync(cfg.out, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report));

if (cfg.strict && violations.length > 0) {
  process.exit(1);
}
