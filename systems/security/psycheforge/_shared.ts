#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const DEFAULT_POLICY_PATH = process.env.PSYCHEFORGE_POLICY_PATH
  ? path.resolve(process.env.PSYCHEFORGE_POLICY_PATH)
  : path.join(ROOT, 'config', 'psycheforge_policy.json');

function nowIso() {
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

function parseArgs(argv: string[]) {
  const out: Record<string, any> = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const tok = String(argv[i] || '');
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

function toBool(v: unknown, fallback = false) {
  if (v == null) return fallback;
  const raw = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function clampInt(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

function clampNumber(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
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

function writeJsonAtomic(filePath: string, value: Record<string, any>) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${Date.now()}-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function appendJsonl(filePath: string, row: Record<string, any>) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function resolvePath(raw: unknown, fallbackRel: string) {
  const txt = cleanText(raw, 520);
  if (!txt) return path.join(ROOT, fallbackRel);
  return path.isAbsolute(txt) ? txt : path.join(ROOT, txt);
}

function stableHash(v: unknown, len = 16) {
  return crypto.createHash('sha256').update(String(v == null ? '' : v), 'utf8').digest('hex').slice(0, len);
}

function resolveEncryptionKey(policy: Record<string, any>) {
  const envName = cleanText(policy && policy.encryption && policy.encryption.key_env || 'PSYCHEFORGE_PROFILE_KEY', 80)
    || 'PSYCHEFORGE_PROFILE_KEY';
  const fromEnv = String(process.env[envName] || '');
  const source = fromEnv || cleanText(policy && policy.encryption && policy.encryption.default_key || '', 120);
  return {
    env_name: envName,
    key: source || 'psycheforge_local_dev_key'
  };
}

function deriveCipherKey(source: string) {
  return crypto.createHash('sha256').update(String(source || ''), 'utf8').digest();
}

function encryptJson(value: Record<string, any>, keySource: string) {
  const iv = crypto.randomBytes(12);
  const key = deriveCipherKey(keySource);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    schema_id: 'psycheforge_profile_envelope',
    schema_version: '1.0',
    algorithm: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    plaintext_sha256: crypto.createHash('sha256').update(plaintext).digest('hex')
  };
}

function decryptJson(envelope: Record<string, any>, keySource: string) {
  const iv = Buffer.from(String(envelope.iv || ''), 'base64');
  const tag = Buffer.from(String(envelope.tag || ''), 'base64');
  const ciphertext = Buffer.from(String(envelope.ciphertext || ''), 'base64');
  const key = deriveCipherKey(keySource);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plaintext.toString('utf8'));
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    shadow_only: true,
    default_risk_tier: 2,
    activation_tier_threshold: 3,
    behavior_classes: [
      'impatient',
      'methodical',
      'aggressive',
      'cautious',
      'overconfident',
      'script_kiddie',
      'nation_state'
    ],
    rust_memory: {
      enabled: true,
      command_base: [
        'cargo',
        'run',
        '--quiet',
        '--manifest-path',
        'crates/memory/Cargo.toml',
        '--bin',
        'memory-cli',
        '--'
      ],
      root: '.',
      db_path: '',
      key_prefix: 'psycheforge.profile'
    },
    encryption: {
      key_env: 'PSYCHEFORGE_PROFILE_KEY',
      default_key: ''
    },
    paths: {
      profiles_path: 'state/security/psycheforge/profiles.json',
      latest_path: 'state/security/psycheforge/latest.json',
      receipts_path: 'state/security/psycheforge/receipts.jsonl',
      shadow_queue_path: 'state/security/psycheforge/shadow_queue.json',
      promotion_path: 'state/security/psycheforge/promotions.jsonl',
      guard_hint_path: 'state/security/guard/psycheforge_hint.json',
      redteam_hint_path: 'state/redteam/psycheforge_hint.json',
      venom_hint_path: 'state/security/venom/psycheforge_hint.json',
      fractal_hint_path: 'state/fractal/psycheforge_hint.json'
    }
  };
}

function normalizeList(v: unknown, maxLen = 160) {
  if (Array.isArray(v)) return v.map((row) => cleanText(row, maxLen)).filter(Boolean);
  const raw = cleanText(v || '', 4000);
  if (!raw) return [];
  return raw.split(',').map((row) => cleanText(row, maxLen)).filter(Boolean);
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const rustMemory = raw.rust_memory && typeof raw.rust_memory === 'object' ? raw.rust_memory : {};
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  const encryption = raw.encryption && typeof raw.encryption === 'object' ? raw.encryption : {};
  return {
    version: cleanText(raw.version || base.version, 32) || base.version,
    enabled: raw.enabled !== false,
    shadow_only: raw.shadow_only !== false,
    default_risk_tier: clampInt(raw.default_risk_tier, 1, 4, base.default_risk_tier),
    activation_tier_threshold: clampInt(raw.activation_tier_threshold, 1, 4, base.activation_tier_threshold),
    behavior_classes: normalizeList(raw.behavior_classes || base.behavior_classes, 80),
    rust_memory: {
      enabled: rustMemory.enabled !== false,
      command_base: normalizeList(rustMemory.command_base || base.rust_memory.command_base, 260),
      root: cleanText(rustMemory.root || base.rust_memory.root, 200) || '.',
      db_path: cleanText(rustMemory.db_path || base.rust_memory.db_path, 400),
      key_prefix: normalizeToken(rustMemory.key_prefix || base.rust_memory.key_prefix, 120) || base.rust_memory.key_prefix
    },
    encryption: {
      key_env: cleanText(encryption.key_env || base.encryption.key_env, 80) || base.encryption.key_env,
      default_key: cleanText(encryption.default_key || base.encryption.default_key, 120)
    },
    paths: {
      profiles_path: resolvePath(paths.profiles_path, base.paths.profiles_path),
      latest_path: resolvePath(paths.latest_path, base.paths.latest_path),
      receipts_path: resolvePath(paths.receipts_path, base.paths.receipts_path),
      shadow_queue_path: resolvePath(paths.shadow_queue_path, base.paths.shadow_queue_path),
      promotion_path: resolvePath(paths.promotion_path, base.paths.promotion_path),
      guard_hint_path: resolvePath(paths.guard_hint_path, base.paths.guard_hint_path),
      redteam_hint_path: resolvePath(paths.redteam_hint_path, base.paths.redteam_hint_path),
      venom_hint_path: resolvePath(paths.venom_hint_path, base.paths.venom_hint_path),
      fractal_hint_path: resolvePath(paths.fractal_hint_path, base.paths.fractal_hint_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function emit(payload: Record<string, any>, code = 0) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exit(code);
}

module.exports = {
  ROOT,
  DEFAULT_POLICY_PATH,
  nowIso,
  cleanText,
  normalizeToken,
  parseArgs,
  toBool,
  clampInt,
  clampNumber,
  ensureDir,
  readJson,
  writeJsonAtomic,
  appendJsonl,
  resolvePath,
  stableHash,
  resolveEncryptionKey,
  encryptJson,
  decryptJson,
  loadPolicy,
  emit
};
