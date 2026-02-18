#!/usr/bin/env node
/**
 * systems/security/skill_quarantine.js
 *
 * Deterministic local analyzer for skill installs:
 * - Validates install spec against policy
 * - Scans installed skill paths for manifests + risky markers
 * - Computes stable hash trees for auditability
 *
 * This script does not install anything and does not use network.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const POLICY_PATH = path.join(REPO_ROOT, 'config', 'skill_install_policy.json');

function nowIso() {
  return new Date().toISOString();
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/security/skill_quarantine.js inspect --spec "<source>"');
  console.log('  node systems/security/skill_quarantine.js verify --path "<skill_dir_or_file>"');
  console.log('  node systems/security/skill_quarantine.js hash-tree --path "<skill_dir_or_file>"');
}

function parseArg(name, fallback = null) {
  const pref = `--${name}=`;
  const eq = process.argv.find(a => a.startsWith(pref));
  if (eq) return eq.slice(pref.length);
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && idx + 1 < process.argv.length) {
    const nxt = process.argv[idx + 1];
    if (!String(nxt).startsWith('--')) return nxt;
    return '';
  }
  return fallback;
}

function hasFlag(flag) {
  return process.argv.includes(`--${flag}`) || process.argv.includes(flag);
}

function loadPolicy() {
  const fallback = {
    version: '1.0-fallback',
    install_root: path.join(REPO_ROOT, 'skills'),
    receipt_dir: path.join(REPO_ROOT, 'state', 'security', 'skill_quarantine', 'install_receipts'),
    allowed_spec_prefixes: ['github:', 'local:', 'file:', 'https://', 'git+https://'],
    blocked_substrings: ['..', ';', '&&', '||', '`', '$(', '>', '<'],
    install_command: ['npx', 'molthub', 'install'],
    manifest_candidates: ['skill.json', 'manifest.json', 'SKILL.md', 'README.md'],
    scan_extensions: ['.js', '.mjs', '.cjs', '.ts', '.sh', '.py', '.json', '.md'],
    trust_file_extensions: ['.js', '.mjs', '.cjs', '.ts', '.sh', '.py'],
    risky_permission_markers: ['network: allow', 'child_process', 'exec(', 'execSync(', 'spawn(', 'spawnSync(', 'api key', 'token', 'secret', 'credential'],
    approval_required: { unknown_manifest: true, risky_markers: true },
    max_scan_files: 200,
    max_scan_bytes: 262144
  };

  try {
    if (!fs.existsSync(POLICY_PATH)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(POLICY_PATH, 'utf8'));
    return {
      ...fallback,
      ...parsed,
      approval_required: {
        ...fallback.approval_required,
        ...(parsed && parsed.approval_required ? parsed.approval_required : {})
      }
    };
  } catch {
    return fallback;
  }
}

function normalizeSpec(spec) {
  return String(spec || '').trim();
}

function inspectSpec(spec, policy) {
  const s = normalizeSpec(spec);
  const reasons = [];
  if (!s) reasons.push('empty_spec');
  if (s.length > 240) reasons.push('spec_too_long');
  for (const bad of policy.blocked_substrings || []) {
    if (bad && s.includes(bad)) reasons.push(`blocked_substring:${bad}`);
  }
  const allowedPrefix = (policy.allowed_spec_prefixes || []).some(p => p && s.startsWith(String(p)));
  if (!allowedPrefix) reasons.push('prefix_not_allowed');
  return {
    ts: nowIso(),
    type: 'spec_inspection',
    spec: s,
    allowed: reasons.length === 0,
    reasons
  };
}

function isTextExt(file, policy) {
  const ext = path.extname(file).toLowerCase();
  return (policy.scan_extensions || []).includes(ext);
}

function isTrustExt(file, policy) {
  const ext = path.extname(file).toLowerCase();
  return (policy.trust_file_extensions || []).includes(ext);
}

function walkFiles(root, maxFiles) {
  const out = [];
  const stack = [root];
  while (stack.length && out.length < maxFiles) {
    const cur = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const ent of entries) {
      const full = path.join(cur, ent.name);
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) {
        stack.push(full);
      } else if (ent.isFile()) {
        out.push(full);
        if (out.length >= maxFiles) break;
      }
    }
  }
  return out.sort();
}

function sha256Bytes(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function safeReadText(filePath, maxBytes) {
  try {
    const st = fs.statSync(filePath);
    if (st.size > maxBytes) return '';
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function detectRisk(text, markers) {
  const lower = String(text || '').toLowerCase();
  const hits = [];
  for (const m of markers || []) {
    const mm = String(m || '').toLowerCase();
    if (mm && lower.includes(mm)) hits.push(mm);
  }
  return Array.from(new Set(hits)).sort();
}

function findManifestFiles(targetPath, policy) {
  const names = new Set((policy.manifest_candidates || []).map(x => String(x || '').toLowerCase()));
  const out = [];
  const maxFiles = Number(policy.max_scan_files || 200);
  const files = fs.statSync(targetPath).isDirectory()
    ? walkFiles(targetPath, maxFiles)
    : [targetPath];
  for (const f of files) {
    const base = path.basename(f).toLowerCase();
    if (names.has(base)) out.push(f);
  }
  return out.sort();
}

function treeHash(targetPath, policy) {
  const maxFiles = Number(policy.max_scan_files || 200);
  const files = fs.statSync(targetPath).isDirectory()
    ? walkFiles(targetPath, maxFiles)
    : [targetPath];
  const relBase = fs.statSync(targetPath).isDirectory() ? targetPath : path.dirname(targetPath);
  const items = [];
  for (const f of files.sort()) {
    try {
      const data = fs.readFileSync(f);
      items.push({
        path: path.relative(relBase, f).replace(/\\/g, '/'),
        sha256: sha256Bytes(data),
        bytes: data.length
      });
    } catch {}
  }
  const rollup = sha256Bytes(Buffer.from(items.map(i => `${i.path}:${i.sha256}:${i.bytes}`).join('\n')));
  return { file_count: items.length, files: items, tree_sha256: rollup };
}

function verifyPath(targetPath, policy) {
  const abs = path.resolve(String(targetPath || ''));
  const result = {
    ts: nowIso(),
    type: 'skill_verification',
    path: abs,
    exists: fs.existsSync(abs),
    is_directory: false,
    manifests: [],
    unknown_manifest: true,
    risky_markers: [],
    trust_candidates: [],
    hash_tree: null,
    requires_approval: false,
    approval_reasons: []
  };
  if (!result.exists) {
    result.approval_reasons.push('path_missing');
    result.requires_approval = true;
    return result;
  }

  let stat;
  try {
    stat = fs.statSync(abs);
  } catch {
    result.approval_reasons.push('stat_failed');
    result.requires_approval = true;
    return result;
  }
  result.is_directory = stat.isDirectory();

  const maxFiles = Number(policy.max_scan_files || 200);
  const maxBytes = Number(policy.max_scan_bytes || 262144);
  const manifests = findManifestFiles(abs, policy);
  result.manifests = manifests.map(f => path.relative(REPO_ROOT, f).replace(/\\/g, '/'));
  result.unknown_manifest = manifests.length === 0;

  const files = stat.isDirectory() ? walkFiles(abs, maxFiles) : [abs];
  const risky = new Set();
  const trustCandidates = [];
  for (const f of files) {
    if (isTrustExt(f, policy)) trustCandidates.push(f);
    if (!isTextExt(f, policy)) continue;
    const txt = safeReadText(f, maxBytes);
    if (!txt) continue;
    for (const hit of detectRisk(txt, policy.risky_permission_markers || [])) risky.add(hit);
  }

  result.risky_markers = Array.from(risky).sort();
  result.trust_candidates = Array.from(new Set(trustCandidates))
    .sort()
    .map(f => path.relative(REPO_ROOT, f).replace(/\\/g, '/'));
  result.hash_tree = treeHash(abs, policy);

  if (policy.approval_required && policy.approval_required.unknown_manifest && result.unknown_manifest) {
    result.approval_reasons.push('unknown_manifest');
  }
  if (policy.approval_required && policy.approval_required.risky_markers && result.risky_markers.length > 0) {
    result.approval_reasons.push('risky_markers_detected');
  }
  result.requires_approval = result.approval_reasons.length > 0;
  return result;
}

function main() {
  const cmd = process.argv[2] || '';
  if (!cmd || hasFlag('help') || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    usage();
    process.exit(0);
  }

  const policy = loadPolicy();

  if (cmd === 'inspect') {
    const spec = parseArg('spec', '');
    const out = {
      ok: true,
      policy_version: policy.version,
      inspect: inspectSpec(spec, policy)
    };
    process.stdout.write(JSON.stringify(out) + '\n');
    process.exit(0);
  }

  if (cmd === 'verify') {
    const p = parseArg('path', '');
    if (!p) {
      process.stdout.write(JSON.stringify({ ok: false, error: 'missing --path', ts: nowIso() }) + '\n');
      process.exit(2);
    }
    const out = {
      ok: true,
      policy_version: policy.version,
      verify: verifyPath(p, policy)
    };
    process.stdout.write(JSON.stringify(out) + '\n');
    process.exit(0);
  }

  if (cmd === 'hash-tree') {
    const p = parseArg('path', '');
    if (!p) {
      process.stdout.write(JSON.stringify({ ok: false, error: 'missing --path', ts: nowIso() }) + '\n');
      process.exit(2);
    }
    const abs = path.resolve(p);
    if (!fs.existsSync(abs)) {
      process.stdout.write(JSON.stringify({ ok: false, error: 'path_missing', path: abs, ts: nowIso() }) + '\n');
      process.exit(1);
    }
    const out = {
      ok: true,
      policy_version: policy.version,
      path: abs,
      hash_tree: treeHash(abs, policy)
    };
    process.stdout.write(JSON.stringify(out) + '\n');
    process.exit(0);
  }

  usage();
  process.exit(2);
}

if (require.main === module) main();

module.exports = {
  loadPolicy,
  inspectSpec,
  verifyPath,
  treeHash
};

