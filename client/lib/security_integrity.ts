'use strict';

const fs = require('fs');
const path = require('path');
const { hashFileSha256 } = require('./integrity_hash_utility');

const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_POLICY_PATH = path.join(REPO_ROOT, 'config', 'security_integrity_policy.json');
const DEFAULT_LOG_PATH = path.join(REPO_ROOT, 'state', 'security', 'integrity_violations.jsonl');

function asStringArray(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const x of v) {
    const s = String(x || '').trim();
    if (!s) continue;
    out.push(s.replace(/\\/g, '/'));
  }
  return Array.from(new Set(out));
}

function relPath(p) {
  return path.relative(REPO_ROOT, path.resolve(REPO_ROOT, p)).replace(/\\/g, '/');
}

function toSortedObject(obj) {
  const keys = Object.keys(obj || {}).sort((a, b) => String(a).localeCompare(String(b)));
  const out = {};
  for (const k of keys) out[k] = obj[k];
  return out;
}

function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function walkFiles(dirPath, out = []) {
  if (!fs.existsSync(dirPath)) return out;
  let entries = [];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return out;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    if (e.isSymbolicLink()) continue;
    const abs = path.join(dirPath, e.name);
    if (e.isDirectory()) walkFiles(abs, out);
    else if (e.isFile()) out.push(abs);
  }
  return out;
}

function isPathMatch(rel, rule) {
  const normalizedRule = String(rule || '').trim().replace(/\\/g, '/');
  if (!normalizedRule) return false;
  if (normalizedRule.endsWith('/**')) return rel.startsWith(normalizedRule.slice(0, -3));
  return rel === normalizedRule;
}

function isExcluded(rel, policy) {
  for (const rule of policy.exclude_paths) {
    if (isPathMatch(rel, rule)) return true;
  }
  return false;
}

function hasAllowedExtension(rel, policy) {
  const exts = policy.target_extensions || [];
  if (!exts.length) return true;
  const ext = path.extname(rel).toLowerCase();
  return exts.includes(ext);
}

function normalizeHashes(rawHashes) {
  const src = rawHashes && typeof rawHashes === 'object' ? rawHashes : {};
  const out = {};
  for (const [k, v] of Object.entries(src)) {
    const rel = relPath(k);
    if (!rel || rel.startsWith('../')) continue;
    const digest = String(v || '').trim().toLowerCase();
    if (!digest) continue;
    out[rel] = digest;
  }
  return toSortedObject(out);
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const fallback = {
    version: '1.0',
    target_roots: ['systems/security', 'config/directives'],
    target_extensions: ['.js', '.yaml', '.yml'],
    protected_files: ['lib/directive_resolver.js'],
    exclude_paths: [],
    hashes: {}
  };
  const raw = readJsonSafe(policyPath, {});
  return {
    ...fallback,
    ...raw,
    target_roots: asStringArray(raw.target_roots || fallback.target_roots).map(relPath),
    target_extensions: asStringArray(raw.target_extensions || fallback.target_extensions).map(x => x.toLowerCase()),
    protected_files: asStringArray(raw.protected_files || fallback.protected_files).map(relPath),
    exclude_paths: asStringArray(raw.exclude_paths || fallback.exclude_paths).map(relPath),
    hashes: normalizeHashes(raw.hashes || {})
  };
}

function collectPresentProtectedFiles(policy) {
  const out = new Set<string>();

  for (const rootRel of policy.target_roots) {
    const absRoot = path.resolve(REPO_ROOT, rootRel);
    for (const absFile of walkFiles(absRoot, [])) {
      const rel = relPath(absFile);
      if (rel.startsWith('../')) continue;
      if (isExcluded(rel, policy)) continue;
      if (!hasAllowedExtension(rel, policy)) continue;
      out.add(rel);
    }
  }

  for (const rel of policy.protected_files) {
    if (isExcluded(rel, policy)) continue;
    const abs = path.resolve(REPO_ROOT, rel);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) out.add(rel);
  }

  return Array.from(out).sort((a, b) => a.localeCompare(b));
}

function summarizeViolations(violations) {
  const counts = {};
  for (const v of violations) {
    const key = String(v && v.type || 'unknown');
    counts[key] = Number(counts[key] || 0) + 1;
  }
  return toSortedObject(counts);
}

function verifyIntegrity(policyPath = DEFAULT_POLICY_PATH) {
  const policy = loadPolicy(policyPath);
  const policyHashes = policy.hashes || {};
  const expectedPaths = Object.keys(policyHashes).sort((a, b) => a.localeCompare(b));
  const expectedSet = new Set(expectedPaths);
  const presentPaths = collectPresentProtectedFiles(policy);
  const presentSet = new Set(presentPaths);
  const violations = [];

  if (!expectedPaths.length) {
    violations.push({ type: 'policy_unsealed', file: null, detail: 'hashes_empty' });
  }

  for (const rel of expectedPaths) {
    const abs = path.resolve(REPO_ROOT, rel);
    if (!fs.existsSync(abs)) {
      violations.push({ type: 'missing_sealed_file', file: rel });
      continue;
    }
    const expected = String(policyHashes[rel] || '').trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(expected)) {
      violations.push({ type: 'invalid_hash_entry', file: rel, expected });
      continue;
    }
    const actual = hashFileSha256(abs);
    if (actual !== expected) {
      violations.push({ type: 'hash_mismatch', file: rel, expected, actual });
    }
  }

  for (const rel of presentPaths) {
    if (!expectedSet.has(rel)) {
      violations.push({ type: 'unsealed_file', file: rel });
    }
  }

  for (const rel of expectedPaths) {
    if (!presentSet.has(rel)) {
      // Catches cases where sealed files moved outside protected scope.
      if (!violations.some(v => v.type === 'missing_sealed_file' && v.file === rel)) {
        violations.push({ type: 'sealed_file_outside_scope', file: rel });
      }
    }
  }

  const counts = summarizeViolations(violations);
  return {
    ok: violations.length === 0,
    ts: new Date().toISOString(),
    policy_path: path.resolve(policyPath),
    policy_version: policy.version,
    checked_present_files: presentPaths.length,
    expected_files: expectedPaths.length,
    violations,
    violation_counts: counts
  };
}

function sealIntegrity(policyPath = DEFAULT_POLICY_PATH, options = {}) {
  const existing = loadPolicy(policyPath);
  const presentPaths = collectPresentProtectedFiles(existing);
  const hashes: Record<string, string> = {};
  for (const rel of presentPaths) {
    const abs = path.resolve(REPO_ROOT, rel);
    hashes[rel] = hashFileSha256(abs);
  }
  const opts = (options && typeof options === 'object' ? options : {}) as Record<string, unknown>;
  const note = String(opts.approval_note || '').trim();
  const next: Record<string, unknown> = {
    version: existing.version || '1.0',
    target_roots: existing.target_roots,
    target_extensions: existing.target_extensions,
    protected_files: existing.protected_files,
    exclude_paths: existing.exclude_paths,
    hashes: toSortedObject(hashes),
    sealed_at: new Date().toISOString(),
    sealed_by: String(opts.sealed_by || process.env.USER || 'unknown')
  };
  if (note) next.last_approval_note = note.slice(0, 240);

  const absPolicyPath = path.resolve(policyPath);
  fs.mkdirSync(path.dirname(absPolicyPath), { recursive: true });
  fs.writeFileSync(absPolicyPath, JSON.stringify(next, null, 2) + '\n', 'utf8');

  return {
    ok: true,
    policy_path: absPolicyPath,
    policy_version: next.version,
    sealed_files: presentPaths.length,
    sealed_at: next.sealed_at
  };
}

function appendIntegrityEvent(entry, logPath = DEFAULT_LOG_PATH) {
  try {
    const absLog = path.resolve(logPath);
    fs.mkdirSync(path.dirname(absLog), { recursive: true });
    fs.appendFileSync(absLog, JSON.stringify(entry) + '\n', 'utf8');
  } catch {
    // Must never block caller.
  }
}

module.exports = {
  DEFAULT_POLICY_PATH,
  DEFAULT_LOG_PATH,
  loadPolicy,
  collectPresentProtectedFiles,
  verifyIntegrity,
  sealIntegrity,
  appendIntegrityEvent
};
export {};
