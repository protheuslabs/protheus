#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const POLICY_PATH = process.env.PROFILE_COMPATIBILITY_POLICY_PATH
  ? path.resolve(process.env.PROFILE_COMPATIBILITY_POLICY_PATH)
  : path.join(ROOT, 'config', 'profile_compatibility_policy.json');

function nowIso() {
  return new Date().toISOString();
}

function cleanText(v: unknown, maxLen = 240) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (const tok of argv) {
    if (!String(tok || '').startsWith('--')) {
      out._.push(String(tok || ''));
      continue;
    }
    const idx = tok.indexOf('=');
    if (idx < 0) out[String(tok || '').slice(2)] = true;
    else out[String(tok || '').slice(2, idx)] = String(tok || '').slice(idx + 1);
  }
  return out;
}

function boolFlag(v: unknown, fallback = false) {
  if (v == null) return fallback;
  const raw = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/profile_compatibility_gate.js run [--strict=1|0]');
  console.log('  node systems/ops/profile_compatibility_gate.js status');
}

function readJson(filePath: string, fallback: AnyObj = {}) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeJsonAtomic(filePath: string, payload: AnyObj) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function appendJsonl(filePath: string, row: AnyObj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function defaultPolicy() {
  return {
    schema_id: 'profile_compatibility_policy',
    schema_version: '1.0',
    enabled: true,
    max_minor_behind: 2,
    profile_schema_path: 'config/capability_profile_schema.json',
    profile_dir: 'state/assimilation/capability_profiles/profiles',
    primitive_catalog_path: 'config/primitive_catalog.json',
    state_path: 'state/ops/profile_compatibility_gate/latest.json',
    history_path: 'state/ops/profile_compatibility_gate/history.jsonl'
  };
}

function resolvePath(raw: unknown, fallbackRel: string) {
  const text = cleanText(raw, 320);
  if (!text) return path.join(ROOT, fallbackRel);
  return path.isAbsolute(text) ? text : path.join(ROOT, text);
}

function loadPolicy() {
  const base = defaultPolicy();
  const raw = readJson(POLICY_PATH, base);
  return {
    schema_id: 'profile_compatibility_policy',
    schema_version: cleanText(raw.schema_version || base.schema_version, 24) || '1.0',
    enabled: raw.enabled !== false,
    max_minor_behind: Math.max(0, Math.min(12, Number(raw.max_minor_behind || base.max_minor_behind) || base.max_minor_behind)),
    profile_schema_path: resolvePath(raw.profile_schema_path || base.profile_schema_path, base.profile_schema_path),
    profile_dir: resolvePath(raw.profile_dir || base.profile_dir, base.profile_dir),
    primitive_catalog_path: resolvePath(raw.primitive_catalog_path || base.primitive_catalog_path, base.primitive_catalog_path),
    state_path: resolvePath(raw.state_path || base.state_path, base.state_path),
    history_path: resolvePath(raw.history_path || base.history_path, base.history_path)
  };
}

function parseVersion(raw: unknown) {
  const text = cleanText(raw, 24);
  const m = text.match(/^(\d+)\.(\d+)$/);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    raw: `${Number(m[1])}.${Number(m[2])}`
  };
}

function withinNMinus2(candidate: AnyObj, current: AnyObj, maxMinorBehind: number) {
  if (!candidate || !current) return false;
  if (candidate.major !== current.major) return false;
  if (candidate.minor > current.minor) return false;
  const delta = current.minor - candidate.minor;
  return delta <= maxMinorBehind;
}

function collectProfileFiles(profileDir: string) {
  if (!fs.existsSync(profileDir)) return [];
  if (!fs.statSync(profileDir).isDirectory()) return [];
  return fs.readdirSync(profileDir)
    .filter((name: string) => name.endsWith('.json'))
    .map((name: string) => path.join(profileDir, name))
    .sort((a: string, b: string) => a.localeCompare(b));
}

function runGate() {
  const policy = loadPolicy();
  const profileSchema = readJson(policy.profile_schema_path, {});
  const primitiveCatalog = readJson(policy.primitive_catalog_path, {});
  const profileCurrent = parseVersion(profileSchema.schema_version || '1.0');
  const primitiveCurrent = parseVersion(primitiveCatalog.schema_version || '1.0');
  const failures: AnyObj[] = [];

  if (!profileCurrent) failures.push({ type: 'profile_schema_version_invalid', value: profileSchema.schema_version || null });
  if (!primitiveCurrent) failures.push({ type: 'primitive_catalog_version_invalid', value: primitiveCatalog.schema_version || null });

  const profileFiles = collectProfileFiles(policy.profile_dir);
  const profileRows: AnyObj[] = [];
  for (const filePath of profileFiles) {
    const row = readJson(filePath, {});
    const ver = parseVersion(row.schema_version || '');
    const ok = profileCurrent ? withinNMinus2(ver, profileCurrent, policy.max_minor_behind) : false;
    profileRows.push({
      file: path.relative(ROOT, filePath).replace(/\\/g, '/'),
      schema_version: cleanText(row.schema_version || '', 24) || null,
      ok
    });
    if (!ok) {
      failures.push({
        type: 'profile_schema_version_out_of_window',
        file: path.relative(ROOT, filePath).replace(/\\/g, '/'),
        schema_version: cleanText(row.schema_version || '', 24) || null
      });
    }
  }

  const out = {
    schema_id: 'profile_compatibility_gate',
    schema_version: '1.0',
    ts: nowIso(),
    ok: failures.length === 0,
    max_minor_behind: policy.max_minor_behind,
    profile_schema_version: profileCurrent ? profileCurrent.raw : null,
    primitive_catalog_version: primitiveCurrent ? primitiveCurrent.raw : null,
    checked_profiles: profileRows.length,
    profile_rows: profileRows,
    failures
  };
  writeJsonAtomic(policy.state_path, out);
  appendJsonl(policy.history_path, out);
  return out;
}

function cmdRun(args: AnyObj) {
  const strict = boolFlag(args.strict, false);
  const payload = runGate();
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  if (strict && payload.ok !== true) process.exit(1);
}

function cmdStatus() {
  const policy = loadPolicy();
  if (!fs.existsSync(policy.state_path)) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      reason: 'status_not_found',
      state_path: path.relative(ROOT, policy.state_path).replace(/\\/g, '/')
    }, null, 2)}\n`);
    process.exit(1);
  }
  process.stdout.write(`${fs.readFileSync(policy.state_path, 'utf8')}\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim().toLowerCase();
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'run') return cmdRun(args);
  if (cmd === 'status') return cmdStatus();
  usage();
  process.exit(2);
}

if (require.main === module) {
  main();
}
