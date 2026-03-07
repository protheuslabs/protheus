#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

type AnyObj = Record<string, any>;

function hasWorkspaceMarkers(absPath: string) {
  try {
    if (!absPath || !path.isAbsolute(absPath)) return false;
    return fs.existsSync(path.join(absPath, '.git'))
      || fs.existsSync(path.join(absPath, 'package.json'))
      || fs.existsSync(path.join(absPath, 'AGENTS.md'));
  } catch {
    return false;
  }
}

function findWorkspaceRoot(startAbsPath: string) {
  let cursor = path.resolve(startAbsPath || process.cwd());
  for (let i = 0; i < 12; i += 1) {
    if (hasWorkspaceMarkers(cursor)) return cursor;
    const next = path.dirname(cursor);
    if (!next || next === cursor) break;
    cursor = next;
  }
  return null;
}

function resolveWorkspaceRoot() {
  const envWorkspace = String(process.env.OPENCLAW_WORKSPACE || '').trim();
  if (envWorkspace) {
    const resolved = path.resolve(envWorkspace);
    if (hasWorkspaceMarkers(resolved)) return resolved;
    if (path.isAbsolute(resolved)) return resolved;
  }
  const byDirname = findWorkspaceRoot(path.resolve(__dirname, '..'));
  if (byDirname) return byDirname;
  const byCwd = findWorkspaceRoot(process.cwd());
  if (byCwd) return byCwd;
  return path.resolve(__dirname, '..');
}

const ROOT = resolveWorkspaceRoot();

function nowIso() {
  const override = cleanText(process.env.PROTHEUS_NOW_ISO || '', 80);
  if (override) {
    const ms = Date.parse(override);
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  }
  return new Date().toISOString();
}

function cleanText(v: unknown, maxLen = 260) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeToken(v: unknown, maxLen = 120) {
  return cleanText(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.:/-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function normalizeUpperToken(v: unknown, maxLen = 120) {
  return normalizeToken(v, maxLen).toUpperCase();
}

function toBool(v: unknown, fallback = false) {
  if (v == null) return fallback;
  const raw = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function clampNumber(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function clampInt(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const tok = String(argv[i] || '');
    if (tok === '--help' || tok === '-h') {
      out._.push('--help');
      out.help = true;
      continue;
    }
    if (!tok.startsWith('--')) {
      out._.push(tok);
      continue;
    }
    const eq = tok.indexOf('=');
    if (eq >= 0) {
      out[tok.slice(2, eq)] = tok.slice(eq + 1);
      continue;
    }
    const key = tok.slice(2);
    const next = argv[i + 1];
    if (next != null && !String(next).startsWith('--')) {
      out[key] = String(next);
      i += 1;
      continue;
    }
    out[key] = true;
  }
  return out;
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath: string, fallback: any = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath: string, value: AnyObj) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${Date.now()}-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function appendJsonl(filePath: string, row: AnyObj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function readJsonl(filePath: string) {
  try {
    if (!fs.existsSync(filePath)) return [];
    return String(fs.readFileSync(filePath, 'utf8') || '')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function relPath(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function resolvePath(raw: unknown, fallbackRel: string) {
  const txt = cleanText(raw, 520);
  const expanded = txt
    .replace(/^\$OPENCLAW_WORKSPACE\b/, ROOT)
    .replace(/\$\{OPENCLAW_WORKSPACE\}/g, ROOT);
  if (!expanded) return path.join(ROOT, fallbackRel);
  return path.isAbsolute(expanded) ? expanded : path.join(ROOT, expanded);
}

function parseIsoMs(v: unknown): number | null {
  const ms = Date.parse(String(v || ''));
  return Number.isFinite(ms) ? ms : null;
}

function stableHash(v: unknown, len = 16) {
  return crypto.createHash('sha256').update(String(v == null ? '' : v), 'utf8').digest('hex').slice(0, len);
}

function loadPolicy(policyPath: string, defaults: AnyObj) {
  const raw = readJson(policyPath, {});
  const merged = {
    ...defaults,
    ...(raw && typeof raw === 'object' ? raw : {})
  };
  return merged;
}

function rollingAverage(rows: number[]) {
  const vals = rows.map((n) => Number(n)).filter((n) => Number.isFinite(n));
  if (!vals.length) return null;
  return Number((vals.reduce((acc, n) => acc + n, 0) / vals.length).toFixed(6));
}

function median(rows: number[]) {
  const vals = rows.map((n) => Number(n)).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!vals.length) return null;
  const mid = Math.floor(vals.length / 2);
  if (vals.length % 2 === 1) return vals[mid];
  return Number(((vals[mid - 1] + vals[mid]) / 2).toFixed(6));
}

function emit(payload: AnyObj, exitCode = 0) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exit(exitCode);
}

module.exports = {
  ROOT,
  resolveWorkspaceRoot,
  nowIso,
  cleanText,
  normalizeToken,
  normalizeUpperToken,
  toBool,
  clampInt,
  clampNumber,
  parseArgs,
  ensureDir,
  readJson,
  writeJsonAtomic,
  appendJsonl,
  readJsonl,
  relPath,
  resolvePath,
  parseIsoMs,
  stableHash,
  loadPolicy,
  rollingAverage,
  median,
  emit
};
