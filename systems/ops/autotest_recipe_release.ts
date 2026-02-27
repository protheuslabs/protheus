#!/usr/bin/env node
'use strict';
export {};

/**
 * autotest_recipe_release.js
 *
 * V2-049 signed recipe release channel.
 *
 * Usage:
 *   node systems/ops/autotest_recipe_release.js seal [--policy=path] [--manifest=path] [--channel=stable|canary] [--release-seq=N]
 *   node systems/ops/autotest_recipe_release.js verify [--policy=path] [--manifest=path]
 *   node systems/ops/autotest_recipe_release.js digest [--policy=path]
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = path.join(ROOT, 'config', 'autotest_doctor_policy.json');
const DEFAULT_MANIFEST_PATH = path.join(ROOT, 'state', 'ops', 'autotest_doctor', 'recipe_release_manifest.json');

function nowIso() {
  return new Date().toISOString();
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (const tok of argv) {
    const raw = String(tok || '');
    if (!raw.startsWith('--')) {
      out._.push(raw);
      continue;
    }
    const idx = raw.indexOf('=');
    if (idx === -1) out[raw.slice(2)] = true;
    else out[raw.slice(2, idx)] = raw.slice(idx + 1);
  }
  return out;
}

function clean(v: unknown, maxLen = 260) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeToken(v: unknown, maxLen = 80) {
  return clean(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function stableStringify(value: unknown): string {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((row) => stableStringify(row)).join(',')}]`;
  const obj = value as AnyObj;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

function hmacHex(value: unknown, key: string) {
  return crypto
    .createHmac('sha256', String(key || ''))
    .update(stableStringify(value))
    .digest('hex');
}

function timingSafeEq(a: unknown, b: unknown) {
  const aa = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  if (aa.length !== bb.length) return false;
  try {
    return crypto.timingSafeEqual(aa, bb);
  } catch {
    return false;
  }
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath: string, fallback: any) {
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

function relPath(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function resolvePath(raw: unknown, fallbackAbs: string) {
  const s = clean(raw, 260);
  if (!s) return fallbackAbs;
  return path.isAbsolute(s) ? s : path.join(ROOT, s);
}

function normalizeTokenList(v: unknown, maxLen = 64) {
  return (Array.isArray(v) ? v : [])
    .map((row) => normalizeToken(row, maxLen))
    .filter(Boolean);
}

function normalizeRecipe(row: AnyObj) {
  const src = row && typeof row === 'object' ? row : {};
  return {
    id: normalizeToken(src.id, 80),
    enabled: src.enabled !== false,
    applies_to: normalizeTokenList(src.applies_to, 48),
    steps: normalizeTokenList(src.steps, 80)
  };
}

function loadPolicy(policyPath: string) {
  const raw = readJson(policyPath, {});
  return {
    version: clean(raw.version || '1.0', 24) || '1.0',
    recipe_release: raw.recipe_release && typeof raw.recipe_release === 'object' ? raw.recipe_release : {},
    recipes: Array.isArray(raw.recipes) ? raw.recipes.map((row) => normalizeRecipe(row)).filter((row) => row.id) : []
  };
}

function recipeDigest(recipes: AnyObj[]) {
  return crypto.createHash('sha256').update(stableStringify(recipes)).digest('hex');
}

function seal(args: AnyObj) {
  const policyPath = path.resolve(String(args.policy || DEFAULT_POLICY_PATH));
  const policy = loadPolicy(policyPath);
  const cfg = policy.recipe_release || {};
  const manifestPath = resolvePath(args.manifest || cfg.manifest_path, DEFAULT_MANIFEST_PATH);
  const keyEnv = clean(cfg.key_env || 'AUTOTEST_DOCTOR_RECIPE_KEY', 80) || 'AUTOTEST_DOCTOR_RECIPE_KEY';
  const key = String(process.env[keyEnv] || '').trim();
  if (!key) {
    return {
      ok: false,
      type: 'autotest_recipe_release_seal',
      error: 'recipe_release_key_missing',
      key_env: keyEnv
    };
  }
  const channel = normalizeToken(args.channel || 'stable', 40) || 'stable';
  const seq = Number.isFinite(Number(args['release-seq'])) ? Number(args['release-seq']) : 1;
  const manifestBase = {
    type: 'autotest_recipe_release_manifest',
    generated_at: nowIso(),
    policy_version: policy.version,
    channel,
    release_seq: Math.max(0, Math.floor(seq)),
    recipe_count: policy.recipes.length,
    recipe_digest: recipeDigest(policy.recipes)
  };
  const signature = hmacHex(manifestBase, key);
  const manifest = {
    ...manifestBase,
    signature
  };
  writeJsonAtomic(manifestPath, manifest);
  return {
    ok: true,
    type: 'autotest_recipe_release_seal',
    ts: manifest.generated_at,
    manifest_path: relPath(manifestPath),
    channel,
    release_seq: manifest.release_seq,
    recipe_digest: manifest.recipe_digest
  };
}

function verify(args: AnyObj) {
  const policyPath = path.resolve(String(args.policy || DEFAULT_POLICY_PATH));
  const policy = loadPolicy(policyPath);
  const cfg = policy.recipe_release || {};
  const manifestPath = resolvePath(args.manifest || cfg.manifest_path, DEFAULT_MANIFEST_PATH);
  const manifest = readJson(manifestPath, null);
  if (!manifest || typeof manifest !== 'object') {
    return {
      ok: false,
      type: 'autotest_recipe_release_verify',
      error: 'manifest_missing',
      manifest_path: relPath(manifestPath)
    };
  }
  const expectedDigest = recipeDigest(policy.recipes);
  const digestMatch = clean(manifest.recipe_digest || '', 128) === expectedDigest;
  const keyEnv = clean(cfg.key_env || 'AUTOTEST_DOCTOR_RECIPE_KEY', 80) || 'AUTOTEST_DOCTOR_RECIPE_KEY';
  const key = String(process.env[keyEnv] || '').trim();
  let signatureValid = false;
  if (key) {
    const payload = { ...manifest };
    delete payload.signature;
    signatureValid = timingSafeEq(clean(manifest.signature || '', 128), hmacHex(payload, key));
  }
  const ok = digestMatch && signatureValid;
  return {
    ok,
    type: 'autotest_recipe_release_verify',
    manifest_path: relPath(manifestPath),
    digest_match: digestMatch,
    signature_valid: signatureValid,
    key_present: !!key,
    recipe_digest_manifest: clean(manifest.recipe_digest || '', 128) || null,
    recipe_digest_expected: expectedDigest
  };
}

function digest(args: AnyObj) {
  const policyPath = path.resolve(String(args.policy || DEFAULT_POLICY_PATH));
  const policy = loadPolicy(policyPath);
  return {
    ok: true,
    type: 'autotest_recipe_release_digest',
    policy_path: relPath(policyPath),
    recipe_count: policy.recipes.length,
    recipe_digest: recipeDigest(policy.recipes)
  };
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/autotest_recipe_release.js seal [--policy=path] [--manifest=path] [--channel=stable|canary] [--release-seq=N]');
  console.log('  node systems/ops/autotest_recipe_release.js verify [--policy=path] [--manifest=path]');
  console.log('  node systems/ops/autotest_recipe_release.js digest [--policy=path]');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim().toLowerCase();
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    usage();
    process.exit(0);
  }
  let payload: AnyObj;
  if (cmd === 'seal') payload = seal(args);
  else if (cmd === 'verify') payload = verify(args);
  else if (cmd === 'digest') payload = digest(args);
  else {
    usage();
    process.exit(2);
    return;
  }
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  if (payload.ok !== true) process.exitCode = 1;
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      type: 'autotest_recipe_release',
      error: clean(err && err.message ? err.message : err || 'autotest_recipe_release_failed', 220)
    })}\n`);
    process.exit(1);
  }
}

