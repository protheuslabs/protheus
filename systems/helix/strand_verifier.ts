#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');

function cleanText(v: unknown, maxLen = 240) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeToken(v: unknown, maxLen = 120) {
  return cleanText(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.:/-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function sha256Hex(text: string) {
  return crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}

function stableStringify(value: unknown): string {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((row) => stableStringify(row)).join(',')}]`;
  const obj = value as AnyObj;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

function relPath(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function isGlobPrefixMatch(rel: string, rule: string) {
  const normalized = String(rule || '').trim().replace(/\\/g, '/');
  if (!normalized) return false;
  if (normalized.endsWith('/**')) return rel.startsWith(normalized.slice(0, -3));
  return rel === normalized;
}

function walkFiles(dirPath: string, out: string[] = []) {
  if (!fs.existsSync(dirPath)) return out;
  let entries: AnyObj[] = [];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return out;
  }
  entries.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const abs = path.join(dirPath, String(entry.name || ''));
    if (entry.isDirectory()) walkFiles(abs, out);
    else if (entry.isFile()) out.push(abs);
  }
  return out;
}

function normalizePathList(src: unknown, fallback: string[] = []) {
  const rows = Array.isArray(src) ? src : fallback;
  const out = new Set<string>();
  for (const raw of rows) {
    const token = String(raw || '').trim();
    if (!token) continue;
    out.add(token.replace(/\\/g, '/'));
  }
  return Array.from(out).sort((a, b) => a.localeCompare(b));
}

function normalizeExtList(src: unknown, fallback: string[] = []) {
  const rows = Array.isArray(src) ? src : fallback;
  const out = new Set<string>();
  for (const raw of rows) {
    const token = String(raw || '').trim().toLowerCase();
    if (!token) continue;
    out.add(token.startsWith('.') ? token : `.${token}`);
  }
  return Array.from(out).sort((a, b) => a.localeCompare(b));
}

function fileHash(absPath: string) {
  return crypto.createHash('sha256').update(fs.readFileSync(absPath)).digest('hex');
}

function shouldInclude(rel: string, includeExt: string[], excludePaths: string[]) {
  if (!includeExt.includes(path.extname(rel).toLowerCase())) return false;
  for (const rule of excludePaths) {
    if (isGlobPrefixMatch(rel, rule)) return false;
  }
  return true;
}

function collectProtectedFiles(policy: AnyObj = {}) {
  const cfg = policy && policy.strands && typeof policy.strands === 'object'
    ? policy.strands
    : {};
  const roots = normalizePathList(cfg.roots, ['systems', 'lib', 'config']);
  const includeExt = normalizeExtList(cfg.include_ext, ['.ts', '.js', '.json']);
  const excludePaths = normalizePathList(
    cfg.exclude_paths,
    ['state/**', 'dist/**', 'node_modules/**', 'tmp/**', 'agent-holo-viz/**']
  );
  const protectedFiles = new Set<string>();
  for (const rootRel of roots) {
    const absRoot = path.resolve(ROOT, rootRel);
    for (const abs of walkFiles(absRoot, [])) {
      const rel = relPath(abs);
      if (rel.startsWith('..')) continue;
      if (!shouldInclude(rel, includeExt, excludePaths)) continue;
      protectedFiles.add(rel);
    }
  }
  return Array.from(protectedFiles).sort((a, b) => a.localeCompare(b));
}

function computeMerkleRoot(hashes: string[]) {
  if (!hashes.length) return '';
  let level = hashes.slice(0);
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = i + 1 < level.length ? level[i + 1] : left;
      next.push(sha256Hex(`${left}|${right}`));
    }
    level = next;
  }
  return level[0];
}

function buildHelixManifest(codex: AnyObj, policy: AnyObj = {}, opts: AnyObj = {}) {
  const files = collectProtectedFiles(policy);
  const strands: AnyObj[] = [];
  const rootHash = cleanText(codex && codex.root_hash || '', 200) || sha256Hex('missing_codex_root');
  let prevHash = rootHash;
  for (const rel of files) {
    const abs = path.join(ROOT, rel);
    const fHash = fileHash(abs);
    const body = {
      file: rel,
      file_hash: fHash,
      prev_hash: prevHash,
      codex_root_hash: rootHash
    };
    const strandHash = sha256Hex(stableStringify(body));
    strands.push({
      file: rel,
      file_hash: fHash,
      prev_hash: prevHash,
      codex_root_hash: rootHash,
      strand_hash: strandHash
    });
    prevHash = strandHash;
  }
  const merkleRoot = computeMerkleRoot(strands.map((row) => String(row.strand_hash || '')));
  return {
    schema_id: 'helix_manifest',
    schema_version: '1.0',
    generated_at: String(opts.generated_at || new Date().toISOString()),
    codex_root_hash: rootHash,
    strand_count: strands.length,
    terminal_strand_hash: prevHash,
    merkle_root: merkleRoot,
    strands
  };
}

function verifyHelixManifest(codex: AnyObj, manifest: AnyObj, policy: AnyObj = {}) {
  const expected = buildHelixManifest(codex, policy, {});
  const currentStrands = manifest && Array.isArray(manifest.strands) ? manifest.strands : [];
  const currentByFile = new Map<string, AnyObj>();
  for (const row of currentStrands) {
    const file = String(row && row.file || '').trim();
    if (!file) continue;
    currentByFile.set(file, row);
  }
  const expectedByFile = new Map<string, AnyObj>();
  for (const row of expected.strands) {
    expectedByFile.set(String(row.file || ''), row);
  }
  const mismatches: AnyObj[] = [];
  for (const row of expected.strands) {
    const file = String(row.file || '');
    const cur = currentByFile.get(file);
    if (!cur) {
      mismatches.push({ type: 'strand_missing', file });
      continue;
    }
    if (String(cur.file_hash || '') !== String(row.file_hash || '')) {
      mismatches.push({ type: 'file_hash_mismatch', file });
    }
    if (String(cur.prev_hash || '') !== String(row.prev_hash || '')) {
      mismatches.push({ type: 'prev_hash_mismatch', file });
    }
    if (String(cur.strand_hash || '') !== String(row.strand_hash || '')) {
      mismatches.push({ type: 'strand_hash_mismatch', file });
    }
  }
  for (const file of Array.from(currentByFile.keys()).sort((a, b) => a.localeCompare(b))) {
    if (!expectedByFile.has(file)) {
      mismatches.push({ type: 'unexpected_strand', file });
    }
  }
  if (String(manifest && manifest.codex_root_hash || '') !== String(expected.codex_root_hash || '')) {
    mismatches.push({ type: 'codex_root_hash_mismatch', file: null });
  }
  if (String(manifest && manifest.merkle_root || '') !== String(expected.merkle_root || '')) {
    mismatches.push({ type: 'merkle_root_mismatch', file: null });
  }
  return {
    ok: mismatches.length === 0,
    reason_codes: mismatches.map((row) => normalizeToken(row.type || 'mismatch', 80)),
    mismatches,
    expected_manifest: expected
  };
}

module.exports = {
  collectProtectedFiles,
  buildHelixManifest,
  verifyHelixManifest
};
