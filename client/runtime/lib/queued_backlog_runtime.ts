#!/usr/bin/env node
'use strict';
export {};

// Layer ownership: core/layer0/ops (authoritative)
// Shared CLI helper surface. Pure string/number helpers remain local; file/path authority moved into Rust.

const path = require('path');
const { createOpsLaneBridge } = require('./rust_lane_bridge.ts');

function hasWorkspaceMarkers(absPath) {
  const fs = require('fs');
  try {
    if (!absPath || !path.isAbsolute(absPath)) return false;
    return fs.existsSync(path.join(absPath, '.git'))
      || fs.existsSync(path.join(absPath, 'package.json'))
      || fs.existsSync(path.join(absPath, 'docs/workspace/AGENTS.md'));
  } catch {
    return false;
  }
}

function findWorkspaceRoot(startAbsPath) {
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
  const byDirname = findWorkspaceRoot(path.resolve(__dirname, '..', '..', '..'));
  if (byDirname) return byDirname;
  const byCwd = findWorkspaceRoot(process.cwd());
  if (byCwd) return byCwd;
  return path.resolve(__dirname, '..', '..', '..');
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

function cleanText(v, maxLen = 260) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeToken(v, maxLen = 120) {
  return cleanText(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.:/-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function normalizeUpperToken(v, maxLen = 120) {
  return normalizeToken(v, maxLen).toUpperCase();
}

function toBool(v, fallback = false) {
  if (v == null) return fallback;
  const raw = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function clampNumber(v, lo, hi, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function clampInt(v, lo, hi, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

function parseArgs(argv) {
  const out = { _: [] };
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

process.env.PROTHEUS_OPS_USE_PREBUILT = process.env.PROTHEUS_OPS_USE_PREBUILT || '0';
process.env.PROTHEUS_OPS_LOCAL_TIMEOUT_MS = process.env.PROTHEUS_OPS_LOCAL_TIMEOUT_MS || '120000';
const bridge = createOpsLaneBridge(__dirname, 'queued_backlog_runtime', 'queued-backlog-kernel');

function encodeBase64(value) {
  return Buffer.from(String(value == null ? '' : value), 'utf8').toString('base64');
}

function invoke(command, payload = {}, opts = {}) {
  const out = bridge.run([
    command,
    `--payload-base64=${encodeBase64(JSON.stringify(payload || {}))}`
  ]);
  const receipt = out && out.payload && typeof out.payload === 'object' ? out.payload : null;
  const payloadOut = receipt && receipt.payload && typeof receipt.payload === 'object'
    ? receipt.payload
    : receipt;
  if (out.status !== 0) {
    const message = payloadOut && typeof payloadOut.error === 'string'
      ? payloadOut.error
      : (out && out.stderr ? String(out.stderr).trim() : `queued_backlog_kernel_${command}_failed`);
    if (opts.throwOnError !== false) throw new Error(message || `queued_backlog_kernel_${command}_failed`);
    return { ok: false, error: message || `queued_backlog_kernel_${command}_failed` };
  }
  if (!payloadOut || typeof payloadOut !== 'object') {
    const message = out && out.stderr
      ? String(out.stderr).trim() || `queued_backlog_kernel_${command}_bridge_failed`
      : `queued_backlog_kernel_${command}_bridge_failed`;
    if (opts.throwOnError !== false) throw new Error(message);
    return { ok: false, error: message };
  }
  return payloadOut;
}

function ensureDir(dirPath) {
  invoke('ensure-dir', {
    dir_path: String(dirPath || '')
  });
}

function readJson(filePath, fallback = null) {
  const out = invoke('read-json', {
    file_path: String(filePath || ''),
    fallback
  });
  return out.value == null ? fallback : out.value;
}

function writeJsonAtomic(filePath, value) {
  invoke('write-json-atomic', {
    file_path: String(filePath || ''),
    value
  });
}

function appendJsonl(filePath, row) {
  invoke('append-jsonl', {
    file_path: String(filePath || ''),
    row
  });
}

function readJsonl(filePath) {
  const out = invoke('read-jsonl', {
    file_path: String(filePath || '')
  });
  return Array.isArray(out.rows) ? out.rows : [];
}

function relPath(filePath) {
  return path.relative(ROOT, String(filePath || '')).replace(/\\/g, '/');
}

function resolvePath(raw, fallbackRel) {
  const out = invoke('resolve-path', {
    raw: cleanText(raw, 520),
    fallback_rel: String(fallbackRel || '')
  });
  return String(out.resolved_path || '');
}

function parseIsoMs(v) {
  const ms = Date.parse(String(v || ''));
  return Number.isFinite(ms) ? ms : null;
}

function stableHash(v, len = 16) {
  const out = invoke('stable-hash', {
    value: v,
    len
  });
  return String(out.hash || '');
}

function loadPolicy(policyPath, defaults) {
  const out = invoke('load-policy', {
    policy_path: String(policyPath || ''),
    defaults: defaults && typeof defaults === 'object' ? defaults : {}
  });
  return out.policy && typeof out.policy === 'object' ? out.policy : {};
}

function rollingAverage(rows) {
  const vals = (Array.isArray(rows) ? rows : []).map((n) => Number(n)).filter((n) => Number.isFinite(n));
  if (!vals.length) return null;
  return Number((vals.reduce((acc, n) => acc + n, 0) / vals.length).toFixed(6));
}

function median(rows) {
  const vals = (Array.isArray(rows) ? rows : []).map((n) => Number(n)).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!vals.length) return null;
  const mid = Math.floor(vals.length / 2);
  if (vals.length % 2 === 1) return vals[mid];
  return Number(((vals[mid - 1] + vals[mid]) / 2).toFixed(6));
}

function emit(payload, exitCode = 0) {
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
