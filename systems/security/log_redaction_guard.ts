#!/usr/bin/env node
'use strict';
export {};

import fs from 'fs';
import path from 'path';

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = process.env.LOG_REDACTION_POLICY_PATH
  ? path.resolve(process.env.LOG_REDACTION_POLICY_PATH)
  : path.join(ROOT, 'config', 'log_redaction_policy.json');
const DEFAULT_STATE_DIR = process.env.LOG_REDACTION_STATE_DIR
  ? path.resolve(process.env.LOG_REDACTION_STATE_DIR)
  : path.join(ROOT, 'state', 'security', 'log_redaction_guard');
const DEFAULT_HISTORY_PATH = path.join(DEFAULT_STATE_DIR, 'history.jsonl');
const DEFAULT_LATEST_PATH = path.join(DEFAULT_STATE_DIR, 'latest.json');

function nowIso(): string {
  return new Date().toISOString();
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
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
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function appendJsonl(filePath: string, value: AnyObj): void {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`);
}

function normalizeList(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => String(x || '').trim()).filter(Boolean) : [];
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of argv) {
    if (!raw.startsWith('--')) continue;
    const idx = raw.indexOf('=');
    if (idx === -1) out[raw.slice(2)] = '1';
    else out[raw.slice(2, idx)] = raw.slice(idx + 1);
  }
  return out;
}

function gatherFiles(rootPath: string, includeExt: Set<string>, excludes: string[]): string[] {
  const out: string[] = [];
  if (!fs.existsSync(rootPath)) return out;
  const walk = (dir: string): void => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      const posix = full.replace(/\\/g, '/');
      if (excludes.some((needle) => needle && posix.includes(needle))) continue;
      if (ent.isDirectory()) {
        walk(full);
      } else if (ent.isFile()) {
        const ext = path.extname(ent.name).toLowerCase();
        if (!includeExt.has(ext)) continue;
        out.push(full);
      }
    }
  };
  walk(rootPath);
  return out;
}

function compilePatterns(policy: AnyObj): Array<{ id: string; regex: RegExp; replaceWith: string }> {
  const rows = Array.isArray(policy.patterns) ? policy.patterns : [];
  const out: Array<{ id: string; regex: RegExp; replaceWith: string }> = [];
  for (const row of rows) {
    const id = String(row && row.id || '').trim() || `pattern_${out.length + 1}`;
    const src = String(row && row.regex || '').trim();
    if (!src) continue;
    const replaceWith = String(row && row.replace_with || '[REDACTED]');
    try {
      out.push({ id, regex: new RegExp(src, 'gi'), replaceWith });
    } catch {
      // skip invalid regex
    }
  }
  return out;
}

function runGuard(apply: boolean, strict: boolean): void {
  const policy = readJson(DEFAULT_POLICY_PATH, {});
  if (policy && policy.enabled === false) {
    const out = { ok: true, type: 'log_redaction_guard', skipped: true, reason: 'disabled', ts: nowIso() };
    writeJson(DEFAULT_LATEST_PATH, out);
    process.stdout.write(JSON.stringify(out) + '\n');
    return;
  }

  const includeExtensions = new Set(
    normalizeList(policy.include_extensions).map((ext) => ext.startsWith('.') ? ext.toLowerCase() : `.${ext.toLowerCase()}`)
  );
  if (includeExtensions.size === 0) {
    includeExtensions.add('.log');
    includeExtensions.add('.jsonl');
    includeExtensions.add('.txt');
  }
  const excludeNeedles = normalizeList(policy.exclude_path_substrings);
  const maxFileBytes = Math.max(1024, Number(policy.max_file_bytes || 2 * 1024 * 1024));
  const targets = normalizeList(policy.target_paths);
  const patterns = compilePatterns(policy);

  const files: string[] = [];
  for (const rel of targets.length > 0 ? targets : ['state', 'logs']) {
    const full = path.resolve(ROOT, rel);
    files.push(...gatherFiles(full, includeExtensions, excludeNeedles));
  }

  let filesScanned = 0;
  let filesFlagged = 0;
  let filesRedacted = 0;
  let matchesFound = 0;
  let bytesRedacted = 0;
  const flaggedSamples: AnyObj[] = [];

  for (const filePath of files) {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    if (stat.size > maxFileBytes) continue;
    filesScanned += 1;

    let original = '';
    try {
      original = fs.readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }
    let updated = original;
    const perPattern: Record<string, number> = {};
    for (const p of patterns) {
      const matches = updated.match(p.regex);
      const localCount = Array.isArray(matches) ? matches.length : 0;
      if (localCount > 0) {
        updated = updated.replace(p.regex, typeof p.replaceWith === 'string' ? p.replaceWith : '[REDACTED]');
      }
      if (localCount > 0) perPattern[p.id] = localCount;
    }
    const totalLocal = Object.values(perPattern).reduce((sum, n) => sum + Number(n || 0), 0);
    if (totalLocal <= 0) continue;

    filesFlagged += 1;
    matchesFound += totalLocal;
    const bytesDelta = Math.max(0, Buffer.byteLength(original, 'utf8') - Buffer.byteLength(updated, 'utf8'));
    bytesRedacted += bytesDelta;

    if (apply) {
      try {
        fs.writeFileSync(filePath, updated, 'utf8');
        filesRedacted += 1;
      } catch {
        // leave as flagged only
      }
    }

    if (flaggedSamples.length < 12) {
      flaggedSamples.push({
        path: path.relative(ROOT, filePath),
        matches: totalLocal,
        patterns: perPattern
      });
    }
  }

  const ok = strict ? filesFlagged === 0 : true;
  const out = {
    ok,
    type: 'log_redaction_guard',
    ts: nowIso(),
    apply,
    strict,
    policy_path: path.relative(ROOT, DEFAULT_POLICY_PATH),
    files_scanned: filesScanned,
    files_flagged: filesFlagged,
    files_redacted: filesRedacted,
    matches_found: matchesFound,
    bytes_redacted: bytesRedacted,
    flagged_samples: flaggedSamples
  };
  writeJson(DEFAULT_LATEST_PATH, out);
  appendJsonl(DEFAULT_HISTORY_PATH, out);
  process.stdout.write(JSON.stringify(out) + '\n');
  if (!ok) process.exit(1);
}

function statusCmd(): void {
  const out = readJson(DEFAULT_LATEST_PATH, {});
  process.stdout.write(JSON.stringify({
    ok: true,
    type: 'log_redaction_guard_status',
    ts: nowIso(),
    latest: out
  }) + '\n');
}

function usage(): void {
  console.log('Usage:');
  console.log('  node systems/security/log_redaction_guard.js run [--apply=0|1] [--strict=0|1]');
  console.log('  node systems/security/log_redaction_guard.js scrub');
  console.log('  node systems/security/log_redaction_guard.js status');
}

function main(): void {
  const cmd = String(process.argv[2] || '').trim();
  const args = parseArgs(process.argv.slice(3));
  ensureDir(DEFAULT_STATE_DIR);
  if (cmd === 'run') {
    const apply = String(args.apply || '0') === '1';
    const strict = String(args.strict || '0') === '1';
    runGuard(apply, strict);
    return;
  }
  if (cmd === 'status') {
    statusCmd();
    return;
  }
  if (cmd === 'scrub') {
    runGuard(true, false);
    return;
  }
  usage();
}

if (require.main === module) main();
