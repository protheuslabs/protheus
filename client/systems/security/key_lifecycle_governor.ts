#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = process.env.KEY_LIFECYCLE_POLICY_PATH
  ? path.resolve(process.env.KEY_LIFECYCLE_POLICY_PATH)
  : path.join(ROOT, 'config', 'key_lifecycle_policy.json');

function nowIso() {
  return new Date().toISOString();
}

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

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (const token of argv) {
    if (!String(token || '').startsWith('--')) {
      out._.push(String(token || ''));
      continue;
    }
    const idx = token.indexOf('=');
    if (idx < 0) out[String(token).slice(2)] = true;
    else out[String(token).slice(2, idx)] = String(token).slice(idx + 1);
  }
  return out;
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/security/key_lifecycle_governor.js issue --key-id=<id> --class=<signing|encryption|transport> [--algorithm=<name>] [--hardware-backed=1|0]');
  console.log('  node systems/security/key_lifecycle_governor.js rotate --key-id=<id> [--algorithm=<name>] [--hardware-backed=1|0]');
  console.log('  node systems/security/key_lifecycle_governor.js revoke --key-id=<id>');
  console.log('  node systems/security/key_lifecycle_governor.js recover --key-id=<id> [--approval-note=<text>]');
  console.log('  node systems/security/key_lifecycle_governor.js drill --key-id=<id>');
  console.log('  node systems/security/key_lifecycle_governor.js verify [--strict=1|0]');
  console.log('  node systems/security/key_lifecycle_governor.js status');
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
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
    return fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

function resolvePath(v: unknown) {
  const text = cleanText(v || '', 320);
  if (!text) return ROOT;
  return path.isAbsolute(text) ? text : path.join(ROOT, text);
}

function defaultPolicy() {
  return {
    schema_id: 'key_lifecycle_policy',
    schema_version: '1.0',
    enabled: true,
    default_algorithm: 'ed25519',
    allowed_algorithms: ['ed25519', 'rsa-4096', 'pq-dilithium3'],
    key_classes: ['signing', 'encryption', 'transport'],
    hardware_required_classes: ['signing'],
    min_recovery_shards: 3,
    drill_max_age_days: 30,
    state_path: 'state/security/key_lifecycle/state.json',
    receipts_path: 'state/security/key_lifecycle/receipts.jsonl',
    crypto_agility_contract_path: 'config/crypto_agility_contract.json'
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const base = defaultPolicy();
  const raw = readJson(policyPath, {});
  return {
    schema_id: 'key_lifecycle_policy',
    schema_version: cleanText(raw.schema_version || base.schema_version, 24) || base.schema_version,
    enabled: raw.enabled !== false,
    default_algorithm: normalizeToken(raw.default_algorithm || base.default_algorithm, 80) || base.default_algorithm,
    allowed_algorithms: Array.isArray(raw.allowed_algorithms)
      ? raw.allowed_algorithms.map((row: unknown) => normalizeToken(row, 80)).filter(Boolean)
      : base.allowed_algorithms.slice(0),
    key_classes: Array.isArray(raw.key_classes)
      ? raw.key_classes.map((row: unknown) => normalizeToken(row, 80)).filter(Boolean)
      : base.key_classes.slice(0),
    hardware_required_classes: Array.isArray(raw.hardware_required_classes)
      ? raw.hardware_required_classes.map((row: unknown) => normalizeToken(row, 80)).filter(Boolean)
      : base.hardware_required_classes.slice(0),
    min_recovery_shards: clampInt(raw.min_recovery_shards, 1, 32, base.min_recovery_shards),
    drill_max_age_days: clampInt(raw.drill_max_age_days, 1, 3650, base.drill_max_age_days),
    state_path: resolvePath(raw.state_path || base.state_path),
    receipts_path: resolvePath(raw.receipts_path || base.receipts_path),
    crypto_agility_contract_path: resolvePath(raw.crypto_agility_contract_path || base.crypto_agility_contract_path),
    policy_path: path.resolve(policyPath)
  };
}

function loadState(policy: AnyObj) {
  const raw = readJson(policy.state_path, {});
  const keys = raw.keys && typeof raw.keys === 'object' ? raw.keys : {};
  return {
    schema_id: 'key_lifecycle_state',
    schema_version: '1.0',
    updated_at: cleanText(raw.updated_at || nowIso(), 40) || nowIso(),
    keys
  };
}

function saveState(policy: AnyObj, state: AnyObj) {
  writeJsonAtomic(policy.state_path, {
    schema_id: 'key_lifecycle_state',
    schema_version: '1.0',
    updated_at: nowIso(),
    keys: state.keys && typeof state.keys === 'object' ? state.keys : {}
  });
}

function rel(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function hashMaterial(seed: string) {
  return crypto.createHash('sha256').update(seed, 'utf8').digest('hex');
}

function keyRecord(policy: AnyObj, input: AnyObj, prev: AnyObj = {}) {
  const keyId = normalizeToken(input.key_id || '', 120);
  const keyClass = normalizeToken(input.key_class || input.class || '', 80);
  const algorithm = normalizeToken(input.algorithm || policy.default_algorithm, 80) || policy.default_algorithm;
  const version = clampInt(input.version != null ? input.version : 1, 1, 1_000_000, 1);
  const hardwareBacked = input.hardware_backed === true;
  const materialHash = hashMaterial(`${keyId}|${algorithm}|${version}|${Date.now()}|${Math.random()}`);
  return {
    key_id: keyId,
    key_class: keyClass,
    algorithm,
    version,
    status: cleanText(input.status || 'active', 24) || 'active',
    hardware_backed: hardwareBacked,
    created_at: cleanText(prev.created_at || nowIso(), 40) || nowIso(),
    rotated_at: input.rotated_at ? cleanText(input.rotated_at, 40) : null,
    revoked_at: input.revoked_at ? cleanText(input.revoked_at, 40) : null,
    recovered_at: input.recovered_at ? cleanText(input.recovered_at, 40) : null,
    superseded_by: cleanText(input.superseded_by || '', 120) || null,
    rotation_parent: cleanText(input.rotation_parent || '', 120) || null,
    recovery: {
      shard_count: clampInt(input.recovery && input.recovery.shard_count, 1, 64, policy.min_recovery_shards),
      last_drill_at: cleanText(input.recovery && input.recovery.last_drill_at || prev.recovery && prev.recovery.last_drill_at || '', 40) || null
    },
    material_hash: materialHash,
    history: Array.isArray(prev.history) ? prev.history.slice(-200) : []
  };
}

function emitReceipt(policy: AnyObj, type: string, payload: AnyObj) {
  appendJsonl(policy.receipts_path, {
    ts: nowIso(),
    type,
    ...payload
  });
}

function assertAllowed(policy: AnyObj, keyClass: string, algorithm: string) {
  const failures: string[] = [];
  if (!policy.key_classes.includes(keyClass)) failures.push('key_class_not_allowed');
  if (!policy.allowed_algorithms.includes(algorithm)) failures.push('algorithm_not_allowed');
  return failures;
}

function cmdIssue(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const state = loadState(policy);
  const keyId = normalizeToken(args['key-id'] || args.key_id || '', 120);
  const keyClass = normalizeToken(args.class || args['key-class'] || '', 80);
  const algorithm = normalizeToken(args.algorithm || policy.default_algorithm, 80) || policy.default_algorithm;
  const hardwareBacked = toBool(args['hardware-backed'], false);

  const failures = [];
  if (!keyId) failures.push('key_id_required');
  if (!keyClass) failures.push('key_class_required');
  failures.push(...assertAllowed(policy, keyClass, algorithm));
  if (state.keys[keyId]) failures.push('key_id_already_exists');
  if (policy.hardware_required_classes.includes(keyClass) && !hardwareBacked) failures.push('hardware_backed_required');

  if (failures.length) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'key_issue', failures })}\n`);
    process.exit(1);
  }

  const rec = keyRecord(policy, {
    key_id: keyId,
    key_class: keyClass,
    algorithm,
    hardware_backed: hardwareBacked,
    status: 'active',
    recovery: {
      shard_count: policy.min_recovery_shards
    }
  });
  rec.history.push({ ts: nowIso(), action: 'issue', algorithm, version: rec.version });
  state.keys[keyId] = rec;
  saveState(policy, state);
  emitReceipt(policy, 'key_issued', {
    key_id: keyId,
    key_class: keyClass,
    algorithm,
    version: rec.version,
    hardware_backed: hardwareBacked
  });

  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'key_issue',
    key_id: keyId,
    key_class: keyClass,
    algorithm,
    version: rec.version,
    hardware_backed: hardwareBacked
  })}\n`);
}

function cmdRotate(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const state = loadState(policy);
  const keyId = normalizeToken(args['key-id'] || args.key_id || '', 120);
  const key = state.keys[keyId];
  if (!key) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'key_rotate', error: 'key_not_found' })}\n`);
    process.exit(1);
  }
  const algorithm = normalizeToken(args.algorithm || key.algorithm || policy.default_algorithm, 80) || policy.default_algorithm;
  const hardwareBacked = args['hardware-backed'] == null
    ? key.hardware_backed === true
    : toBool(args['hardware-backed'], false);
  const failures = assertAllowed(policy, key.key_class, algorithm);
  if (policy.hardware_required_classes.includes(key.key_class) && !hardwareBacked) {
    failures.push('hardware_backed_required');
  }
  if (failures.length) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'key_rotate', failures })}\n`);
    process.exit(1);
  }

  key.status = 'rotated';
  key.rotated_at = nowIso();
  key.history = Array.isArray(key.history) ? key.history : [];
  key.history.push({ ts: key.rotated_at, action: 'rotated_out', to_version: Number(key.version || 1) + 1 });

  const next = keyRecord(policy, {
    key_id: keyId,
    key_class: key.key_class,
    algorithm,
    version: Number(key.version || 1) + 1,
    hardware_backed: hardwareBacked,
    status: 'active',
    rotation_parent: `${keyId}@v${Number(key.version || 1)}`,
    recovery: key.recovery
  }, key);
  next.history.push({ ts: nowIso(), action: 'rotated_in', from_version: Number(key.version || 1) });

  state.keys[keyId] = next;
  saveState(policy, state);
  emitReceipt(policy, 'key_rotated', {
    key_id: keyId,
    from_version: Number(key.version || 1),
    to_version: next.version,
    algorithm,
    hardware_backed: hardwareBacked
  });

  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'key_rotate',
    key_id: keyId,
    from_version: Number(key.version || 1),
    to_version: next.version,
    algorithm,
    hardware_backed: hardwareBacked
  })}\n`);
}

function cmdRevoke(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const state = loadState(policy);
  const keyId = normalizeToken(args['key-id'] || args.key_id || '', 120);
  const key = state.keys[keyId];
  if (!key) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'key_revoke', error: 'key_not_found' })}\n`);
    process.exit(1);
  }
  key.status = 'revoked';
  key.revoked_at = nowIso();
  key.history = Array.isArray(key.history) ? key.history : [];
  key.history.push({ ts: key.revoked_at, action: 'revoked' });
  state.keys[keyId] = key;
  saveState(policy, state);
  emitReceipt(policy, 'key_revoked', { key_id: keyId, version: Number(key.version || 1) });
  process.stdout.write(`${JSON.stringify({ ok: true, type: 'key_revoke', key_id: keyId, version: Number(key.version || 1) })}\n`);
}

function cmdRecover(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const state = loadState(policy);
  const keyId = normalizeToken(args['key-id'] || args.key_id || '', 120);
  const key = state.keys[keyId];
  if (!key) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'key_recover', error: 'key_not_found' })}\n`);
    process.exit(1);
  }
  const note = cleanText(args['approval-note'] || args.approval_note || 'recovery_ceremony', 240) || 'recovery_ceremony';
  key.status = 'active';
  key.recovered_at = nowIso();
  key.history = Array.isArray(key.history) ? key.history : [];
  key.history.push({ ts: key.recovered_at, action: 'recovered', note });
  state.keys[keyId] = key;
  saveState(policy, state);
  emitReceipt(policy, 'key_recovered', { key_id: keyId, version: Number(key.version || 1), note });
  process.stdout.write(`${JSON.stringify({ ok: true, type: 'key_recover', key_id: keyId, version: Number(key.version || 1), note })}\n`);
}

function cmdDrill(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const state = loadState(policy);
  const keyId = normalizeToken(args['key-id'] || args.key_id || '', 120);
  const key = state.keys[keyId];
  if (!key) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'key_drill', error: 'key_not_found' })}\n`);
    process.exit(1);
  }
  const ts = nowIso();
  key.recovery = key.recovery && typeof key.recovery === 'object' ? key.recovery : { shard_count: policy.min_recovery_shards };
  key.recovery.last_drill_at = ts;
  key.history = Array.isArray(key.history) ? key.history : [];
  key.history.push({ ts, action: 'recovery_drill' });
  state.keys[keyId] = key;
  saveState(policy, state);
  emitReceipt(policy, 'key_recovery_drill', {
    key_id: keyId,
    version: Number(key.version || 1),
    drill_at: ts
  });
  process.stdout.write(`${JSON.stringify({ ok: true, type: 'key_drill', key_id: keyId, version: Number(key.version || 1), drill_at: ts })}\n`);
}

function cmdVerify(args: AnyObj) {
  const strict = toBool(args.strict, false);
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const state = loadState(policy);
  const contract = readJson(policy.crypto_agility_contract_path, {});
  const tracks = contract && contract.migration_tracks && typeof contract.migration_tracks === 'object'
    ? contract.migration_tracks
    : {};

  const failures: AnyObj[] = [];
  const keyRows = Object.values(state.keys || {}) as AnyObj[];
  for (const row of keyRows) {
    const keyId = normalizeToken(row && row.key_id || '', 120);
    const keyClass = normalizeToken(row && row.key_class || '', 80);
    const algorithm = normalizeToken(row && row.algorithm || '', 80);
    if (!keyId) failures.push({ type: 'key_id_missing' });
    if (!policy.key_classes.includes(keyClass)) failures.push({ type: 'key_class_invalid', key_id: keyId, key_class: keyClass });
    if (!policy.allowed_algorithms.includes(algorithm)) failures.push({ type: 'algorithm_invalid', key_id: keyId, algorithm });
    if (policy.hardware_required_classes.includes(keyClass) && row.hardware_backed !== true) {
      failures.push({ type: 'hardware_backed_required', key_id: keyId, key_class: keyClass });
    }
    const track = tracks[algorithm];
    if (!track || !track.target) {
      failures.push({ type: 'crypto_track_missing', key_id: keyId, algorithm });
    }
    if (String(row.status || '') === 'active') {
      const drillAt = Date.parse(String(row && row.recovery && row.recovery.last_drill_at || ''));
      const maxAgeMs = Number(policy.drill_max_age_days || 30) * 24 * 60 * 60 * 1000;
      if (!Number.isFinite(drillAt) || (Date.now() - drillAt) > maxAgeMs) {
        failures.push({ type: 'recovery_drill_stale', key_id: keyId, drill_max_age_days: policy.drill_max_age_days });
      }
    }
  }

  const payload = {
    ok: failures.length === 0,
    type: 'key_lifecycle_verify',
    ts: nowIso(),
    strict,
    policy_version: policy.schema_version,
    policy_path: rel(policy.policy_path),
    state_path: rel(policy.state_path),
    crypto_agility_contract_path: rel(policy.crypto_agility_contract_path),
    key_count: keyRows.length,
    active_keys: keyRows.filter((row) => String(row && row.status || '') === 'active').length,
    failure_count: failures.length,
    failures
  };
  emitReceipt(policy, 'key_lifecycle_verify', {
    ok: payload.ok,
    key_count: payload.key_count,
    active_keys: payload.active_keys,
    failure_count: payload.failure_count
  });
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  if ((strict || policy.enabled) && payload.ok !== true) process.exit(1);
}

function cmdStatus(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const state = loadState(policy);
  const receipts = readJsonl(policy.receipts_path);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'key_lifecycle_status',
    policy_version: policy.schema_version,
    policy_path: rel(policy.policy_path),
    state_path: rel(policy.state_path),
    receipts_path: rel(policy.receipts_path),
    key_count: Object.keys(state.keys || {}).length,
    keys: state.keys,
    recent_receipts: receipts.slice(-20)
  }, null, 2)}\n`);
}

function main(argv: string[]) {
  const args = parseArgs(argv);
  const cmd = String(args._[0] || '').trim().toLowerCase();
  if (!cmd || cmd === 'help' || cmd === '--help' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'issue') return cmdIssue(args);
  if (cmd === 'rotate') return cmdRotate(args);
  if (cmd === 'revoke') return cmdRevoke(args);
  if (cmd === 'recover') return cmdRecover(args);
  if (cmd === 'drill') return cmdDrill(args);
  if (cmd === 'verify') return cmdVerify(args);
  if (cmd === 'status') return cmdStatus(args);
  usage();
  process.exit(2);
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = {
  DEFAULT_POLICY_PATH,
  loadPolicy
};
