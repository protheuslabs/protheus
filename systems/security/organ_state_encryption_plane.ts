#!/usr/bin/env node
'use strict';
export {};

/**
 * organ_state_encryption_plane.js
 *
 * V3-025: per-organ encrypted state/memory/cryonics plane with key versioning,
 * integrity MAC, rotation workflow, and fail-closed unauthorized decrypt path.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = process.env.ORGAN_STATE_ENCRYPTION_POLICY_PATH
  ? path.resolve(String(process.env.ORGAN_STATE_ENCRYPTION_POLICY_PATH))
  : path.join(ROOT, 'config', 'organ_state_encryption_policy.json');

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

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (const tok of argv) {
    if (!String(tok || '').startsWith('--')) {
      out._.push(String(tok || ''));
      continue;
    }
    const idx = tok.indexOf('=');
    if (idx < 0) out[String(tok).slice(2)] = true;
    else out[String(tok).slice(2, idx)] = String(tok).slice(idx + 1);
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

function writeJsonAtomic(filePath: string, payload: AnyObj) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${Date.now()}-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function appendJsonl(filePath: string, row: AnyObj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function resolvePath(v: unknown, fallbackRel: string) {
  const raw = cleanText(v || fallbackRel, 360);
  return path.isAbsolute(raw) ? path.resolve(raw) : path.join(ROOT, raw);
}

function rel(absPath: string) {
  return path.relative(ROOT, absPath).replace(/\\/g, '/');
}

function escapeRegex(text: string) {
  return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isInside(rootDir: string, candidate: string) {
  const root = path.resolve(rootDir);
  const abs = path.resolve(candidate);
  if (abs === root) return true;
  return new RegExp(`^${escapeRegex(root + path.sep)}`, 'i').test(abs + path.sep);
}

function defaultPolicy() {
  return {
    schema_id: 'organ_state_encryption_policy',
    schema_version: '1.0',
    enabled: true,
    unauthorized_fail_closed: true,
    max_rotation_age_days: 90,
    crypto: {
      cipher: 'aes-256-gcm',
      key_bytes: 32,
      iv_bytes: 12,
      mac: 'hmac-sha256'
    },
    paths: {
      keyring_path: 'state/security/organ_state_encryption/keyring.json',
      audit_path: 'state/security/organ_state_encryption/audit.jsonl',
      alerts_path: 'state/ops/system_health/events.jsonl'
    },
    lane_roots: {
      state: 'state',
      memory: 'memory',
      cryonics: 'state/_cryonics'
    },
    organs: {
      workflow: { lanes: ['state'] },
      autonomy: { lanes: ['state'] },
      sensory: { lanes: ['state'] },
      memory: { lanes: ['memory', 'state'] },
      cryonics: { lanes: ['cryonics', 'state'] }
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const base = defaultPolicy();
  const raw = readJson(policyPath, {});
  const cryptoRaw = raw.crypto && typeof raw.crypto === 'object' ? raw.crypto : {};
  const pathsRaw = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  const laneRootsRaw = raw.lane_roots && typeof raw.lane_roots === 'object'
    ? raw.lane_roots
    : base.lane_roots;
  const organsRaw = raw.organs && typeof raw.organs === 'object'
    ? raw.organs
    : base.organs;
  const organs: Record<string, AnyObj> = {};
  for (const [organRaw, rowRaw] of Object.entries(organsRaw)) {
    const organ = normalizeToken(organRaw, 80);
    if (!organ) continue;
    const row = rowRaw && typeof rowRaw === 'object' ? rowRaw as AnyObj : {};
    organs[organ] = {
      lanes: Array.isArray(row.lanes)
        ? row.lanes.map((v: unknown) => normalizeToken(v, 60)).filter(Boolean)
        : ['state']
    };
  }
  return {
    schema_id: 'organ_state_encryption_policy',
    schema_version: cleanText(raw.schema_version || base.schema_version, 24) || base.schema_version,
    enabled: raw.enabled !== false,
    unauthorized_fail_closed: raw.unauthorized_fail_closed !== false,
    max_rotation_age_days: clampInt(raw.max_rotation_age_days, 1, 3650, base.max_rotation_age_days),
    crypto: {
      cipher: cleanText(cryptoRaw.cipher || base.crypto.cipher, 40) || base.crypto.cipher,
      key_bytes: clampInt(cryptoRaw.key_bytes, 16, 64, base.crypto.key_bytes),
      iv_bytes: clampInt(cryptoRaw.iv_bytes, 8, 32, base.crypto.iv_bytes),
      mac: cleanText(cryptoRaw.mac || base.crypto.mac, 40) || base.crypto.mac
    },
    paths: {
      keyring_path: resolvePath(pathsRaw.keyring_path, base.paths.keyring_path),
      audit_path: resolvePath(pathsRaw.audit_path, base.paths.audit_path),
      alerts_path: resolvePath(pathsRaw.alerts_path, base.paths.alerts_path)
    },
    lane_roots: {
      state: resolvePath(laneRootsRaw.state, base.lane_roots.state),
      memory: resolvePath(laneRootsRaw.memory, base.lane_roots.memory),
      cryonics: resolvePath(laneRootsRaw.cryonics, base.lane_roots.cryonics)
    },
    organs,
    policy_path: path.resolve(policyPath)
  };
}

function loadKeyring(policy: AnyObj) {
  const raw = readJson(policy.paths.keyring_path, {});
  const organs = raw.organs && typeof raw.organs === 'object' ? raw.organs : {};
  return {
    schema_id: 'organ_state_encryption_keyring',
    schema_version: '1.0',
    updated_at: cleanText(raw.updated_at || nowIso(), 40) || nowIso(),
    organs
  };
}

function saveKeyring(policy: AnyObj, keyring: AnyObj) {
  writeJsonAtomic(policy.paths.keyring_path, {
    schema_id: 'organ_state_encryption_keyring',
    schema_version: '1.0',
    updated_at: nowIso(),
    organs: keyring.organs && typeof keyring.organs === 'object' ? keyring.organs : {}
  });
}

function audit(policy: AnyObj, action: string, payload: AnyObj) {
  appendJsonl(policy.paths.audit_path, {
    ts: nowIso(),
    type: 'organ_state_encryption',
    action,
    ...payload
  });
}

function emitAlert(policy: AnyObj, reason: string, payload: AnyObj = {}) {
  appendJsonl(policy.paths.alerts_path, {
    ts: nowIso(),
    type: 'system_health_event',
    severity: 'high',
    source: 'organ_state_encryption_plane',
    reason: cleanText(reason, 120) || 'encryption_alert',
    ...payload
  });
}

function ensureOrganAllowed(policy: AnyObj, organId: string, lane: string) {
  const organCfg = policy.organs && policy.organs[organId] ? policy.organs[organId] : null;
  if (!organCfg) return { ok: false, reason: 'organ_not_allowed' };
  const lanes = Array.isArray(organCfg.lanes) ? organCfg.lanes : [];
  if (!lanes.includes(lane)) return { ok: false, reason: 'lane_not_allowed_for_organ' };
  return { ok: true, reason: null };
}

function createVersionRecord(policy: AnyObj, version: number, reason: string) {
  const key = crypto.randomBytes(policy.crypto.key_bytes);
  return {
    version,
    key_b64: key.toString('base64'),
    status: 'active',
    created_at: nowIso(),
    rotated_at: nowIso(),
    reason: cleanText(reason || 'issued', 120) || 'issued'
  };
}

function ensureOrganKey(policy: AnyObj, keyring: AnyObj, organId: string) {
  keyring.organs = keyring.organs && typeof keyring.organs === 'object' ? keyring.organs : {};
  if (!keyring.organs[organId] || typeof keyring.organs[organId] !== 'object') {
    keyring.organs[organId] = {
      active_version: 1,
      versions: {
        '1': createVersionRecord(policy, 1, 'bootstrap')
      }
    };
    return;
  }
  const organ = keyring.organs[organId];
  organ.versions = organ.versions && typeof organ.versions === 'object' ? organ.versions : {};
  const active = clampInt(organ.active_version, 1, 1_000_000, 1);
  if (!organ.versions[String(active)]) {
    organ.versions[String(active)] = createVersionRecord(policy, active, 'repair_missing_active_version');
  }
  organ.active_version = active;
}

function deriveKeys(masterB64: string, organId: string, version: number) {
  const master = Buffer.from(String(masterB64 || ''), 'base64');
  const enc = crypto.createHmac('sha256', master).update(`enc|${organId}|${version}`).digest().subarray(0, 32);
  const mac = crypto.createHmac('sha256', master).update(`mac|${organId}|${version}`).digest();
  return { enc_key: enc, mac_key: mac };
}

function envelopeMacInput(envelope: AnyObj) {
  return [
    cleanText(envelope.schema_id || '', 80),
    cleanText(envelope.organ_id || '', 80),
    cleanText(envelope.lane || '', 40),
    Number(envelope.key_version || 0),
    cleanText(envelope.created_at || '', 40),
    cleanText(envelope.source_rel || '', 280),
    cleanText(envelope.cipher || '', 40),
    cleanText(envelope.mac || '', 40),
    cleanText(envelope.iv_b64 || '', 400),
    cleanText(envelope.tag_b64 || '', 400),
    cleanText(envelope.ciphertext_b64 || '', 1000000)
  ].join('|');
}

function createMac(macKey: Buffer, envelope: AnyObj) {
  return crypto.createHmac('sha256', macKey).update(envelopeMacInput(envelope), 'utf8').digest('base64');
}

function resolveLaneRoot(policy: AnyObj, lane: string) {
  if (lane === 'memory') return policy.lane_roots.memory;
  if (lane === 'cryonics') return policy.lane_roots.cryonics;
  return policy.lane_roots.state;
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/security/organ_state_encryption_plane.js encrypt --organ=<id> --lane=<state|memory|cryonics> --source=<rel|abs> [--out=<rel|abs>]');
  console.log('  node systems/security/organ_state_encryption_plane.js decrypt --organ=<id> --cipher=<rel|abs> --out=<rel|abs>');
  console.log('  node systems/security/organ_state_encryption_plane.js rotate-key --organ=<id> [--reason=<text>]');
  console.log('  node systems/security/organ_state_encryption_plane.js verify [--strict=1|0]');
  console.log('  node systems/security/organ_state_encryption_plane.js status [--organ=<id>]');
}

function cmdEncrypt(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const organId = normalizeToken(args.organ || args['organ-id'] || '', 80);
  const lane = normalizeToken(args.lane || 'state', 40) || 'state';
  const sourceArg = cleanText(args.source || '', 320);
  const outArg = cleanText(args.out || '', 320);
  if (!organId || !sourceArg) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: 'organ_and_source_required' })}\n`);
    process.exit(2);
  }
  const allow = ensureOrganAllowed(policy, organId, lane);
  if (!allow.ok) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: allow.reason })}\n`);
    process.exit(1);
  }
  const sourcePath = path.isAbsolute(sourceArg) ? path.resolve(sourceArg) : path.join(ROOT, sourceArg);
  if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: 'source_not_found', source: sourceArg })}\n`);
    process.exit(1);
  }
  const laneRoot = resolveLaneRoot(policy, lane);
  if (!isInside(laneRoot, sourcePath)) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: 'source_outside_lane_root', lane, lane_root: rel(laneRoot) })}\n`);
    process.exit(1);
  }

  const keyring = loadKeyring(policy);
  ensureOrganKey(policy, keyring, organId);
  const organState = keyring.organs[organId];
  const activeVersion = clampInt(organState.active_version, 1, 1_000_000, 1);
  const keyRec = organState.versions && organState.versions[String(activeVersion)];
  if (!keyRec || !keyRec.key_b64) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: 'active_key_missing' })}\n`);
    process.exit(1);
  }
  const keys = deriveKeys(String(keyRec.key_b64), organId, activeVersion);

  const plain = fs.readFileSync(sourcePath);
  const iv = crypto.randomBytes(policy.crypto.iv_bytes);
  const sourceRel = rel(sourcePath);
  const createdAt = nowIso();
  const cipher = crypto.createCipheriv('aes-256-gcm', keys.enc_key, iv);
  const aad = Buffer.from(`${organId}|${lane}|${activeVersion}|${sourceRel}|${createdAt}`, 'utf8');
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();

  const envelope = {
    schema_id: 'organ_state_encrypted_v1',
    schema_version: '1.0',
    created_at: createdAt,
    organ_id: organId,
    lane,
    key_version: activeVersion,
    source_rel: sourceRel,
    cipher: 'aes-256-gcm',
    mac: 'hmac-sha256',
    iv_b64: iv.toString('base64'),
    tag_b64: tag.toString('base64'),
    ciphertext_b64: ciphertext.toString('base64')
  };
  envelope.mac_b64 = createMac(keys.mac_key, envelope);

  const outPath = outArg
    ? (path.isAbsolute(outArg) ? path.resolve(outArg) : path.join(ROOT, outArg))
    : `${sourcePath}.enc.json`;
  ensureDir(path.dirname(outPath));
  fs.writeFileSync(outPath, `${JSON.stringify(envelope, null, 2)}\n`, 'utf8');
  saveKeyring(policy, keyring);
  audit(policy, 'encrypt', {
    ok: true,
    organ_id: organId,
    lane,
    key_version: activeVersion,
    source_rel: sourceRel,
    envelope_rel: rel(outPath),
    bytes: Number(plain.length || 0)
  });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'organ_state_encrypt',
    organ_id: organId,
    lane,
    key_version: activeVersion,
    source_rel: sourceRel,
    envelope_rel: rel(outPath),
    bytes: Number(plain.length || 0)
  }, null, 2)}\n`);
}

function cmdDecrypt(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const organId = normalizeToken(args.organ || args['organ-id'] || '', 80);
  const cipherArg = cleanText(args.cipher || '', 320);
  const outArg = cleanText(args.out || '', 320);
  if (!organId || !cipherArg || !outArg) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: 'organ_cipher_out_required' })}\n`);
    process.exit(2);
  }
  const cipherPath = path.isAbsolute(cipherArg) ? path.resolve(cipherArg) : path.join(ROOT, cipherArg);
  const outPath = path.isAbsolute(outArg) ? path.resolve(outArg) : path.join(ROOT, outArg);
  if (!fs.existsSync(cipherPath)) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: 'cipher_not_found', cipher: cipherArg })}\n`);
    process.exit(1);
  }

  let envelope: AnyObj = {};
  try {
    envelope = JSON.parse(fs.readFileSync(cipherPath, 'utf8'));
  } catch {
    envelope = {};
  }
  const reasonPrefix = 'unauthorized_decrypt_attempt';
  const failClosed = policy.unauthorized_fail_closed !== false;
  try {
    if (cleanText(envelope.schema_id || '', 80) !== 'organ_state_encrypted_v1') {
      throw new Error('envelope_schema_invalid');
    }
    const envOrgan = normalizeToken(envelope.organ_id || '', 80);
    if (!envOrgan || envOrgan !== organId) throw new Error('organ_mismatch');
    const lane = normalizeToken(envelope.lane || 'state', 40) || 'state';
    const allow = ensureOrganAllowed(policy, organId, lane);
    if (!allow.ok) throw new Error(allow.reason || 'organ_lane_denied');
    const laneRoot = resolveLaneRoot(policy, lane);
    if (!isInside(laneRoot, outPath)) throw new Error('decrypt_output_outside_lane_root');

    const keyring = loadKeyring(policy);
    const organState = keyring.organs && keyring.organs[organId];
    const keyVersion = clampInt(envelope.key_version, 1, 1_000_000, 0);
    const keyRec = organState && organState.versions && organState.versions[String(keyVersion)];
    if (!keyRec || !keyRec.key_b64) throw new Error('key_version_not_found');

    const keys = deriveKeys(String(keyRec.key_b64), organId, keyVersion);
    const expectedMac = createMac(keys.mac_key, envelope);
    const gotMac = cleanText(envelope.mac_b64 || '', 400);
    if (!gotMac || expectedMac !== gotMac) throw new Error('integrity_mac_mismatch');

    const iv = Buffer.from(String(envelope.iv_b64 || ''), 'base64');
    const tag = Buffer.from(String(envelope.tag_b64 || ''), 'base64');
    const ciphertext = Buffer.from(String(envelope.ciphertext_b64 || ''), 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', keys.enc_key, iv);
    const aad = Buffer.from(`${organId}|${lane}|${keyVersion}|${cleanText(envelope.source_rel || '', 280)}|${cleanText(envelope.created_at || '', 40)}`, 'utf8');
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

    ensureDir(path.dirname(outPath));
    fs.writeFileSync(outPath, plain);
    audit(policy, 'decrypt', {
      ok: true,
      organ_id: organId,
      lane,
      key_version: keyVersion,
      envelope_rel: rel(cipherPath),
      output_rel: rel(outPath),
      bytes: Number(plain.length || 0)
    });
    process.stdout.write(`${JSON.stringify({
      ok: true,
      type: 'organ_state_decrypt',
      organ_id: organId,
      lane,
      key_version: keyVersion,
      envelope_rel: rel(cipherPath),
      output_rel: rel(outPath),
      bytes: Number(plain.length || 0)
    }, null, 2)}\n`);
  } catch (err) {
    const reason = cleanText(err && (err as Error).message ? (err as Error).message : err || 'decrypt_failed', 180) || 'decrypt_failed';
    audit(policy, 'decrypt_denied', {
      ok: false,
      organ_id: organId,
      envelope_rel: rel(cipherPath),
      output_rel: rel(outPath),
      reason
    });
    emitAlert(policy, reasonPrefix, {
      organ_id: organId,
      envelope_rel: rel(cipherPath),
      reason
    });
    const out = {
      ok: false,
      type: 'organ_state_decrypt',
      fail_closed: failClosed,
      error: reason,
      reason: `${reasonPrefix}:${reason}`
    };
    process.stdout.write(`${JSON.stringify(out)}\n`);
    process.exit(failClosed ? 1 : 0);
  }
}

function cmdRotateKey(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const organId = normalizeToken(args.organ || args['organ-id'] || '', 80);
  const reason = cleanText(args.reason || 'manual_rotation', 120) || 'manual_rotation';
  if (!organId) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: 'organ_required' })}\n`);
    process.exit(2);
  }
  const allow = ensureOrganAllowed(policy, organId, 'state');
  if (!allow.ok && !policy.organs[organId]) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: 'organ_not_allowed' })}\n`);
    process.exit(1);
  }
  const keyring = loadKeyring(policy);
  ensureOrganKey(policy, keyring, organId);
  const organState = keyring.organs[organId];
  const fromVersion = clampInt(organState.active_version, 1, 1_000_000, 1);
  const toVersion = fromVersion + 1;
  if (organState.versions && organState.versions[String(fromVersion)]) {
    organState.versions[String(fromVersion)].status = 'retired';
  }
  organState.versions[String(toVersion)] = createVersionRecord(policy, toVersion, reason);
  organState.active_version = toVersion;
  saveKeyring(policy, keyring);
  audit(policy, 'rotate_key', {
    ok: true,
    organ_id: organId,
    from_version: fromVersion,
    to_version: toVersion,
    reason
  });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'organ_state_rotate_key',
    organ_id: organId,
    from_version: fromVersion,
    to_version: toVersion,
    reason
  }, null, 2)}\n`);
}

function bootstrapMissingKeys(policy: AnyObj, keyring: AnyObj) {
  let changed = false;
  const organs = policy.organs && typeof policy.organs === 'object'
    ? Object.keys(policy.organs)
    : [];
  for (const organId of organs) {
    const before = JSON.stringify(keyring.organs && keyring.organs[organId] || null);
    ensureOrganKey(policy, keyring, organId);
    const after = JSON.stringify(keyring.organs && keyring.organs[organId] || null);
    if (before !== after) changed = true;
  }
  if (changed) saveKeyring(policy, keyring);
  return changed;
}

function buildStatus(policy: AnyObj, keyring: AnyObj) {
  const now = Date.now();
  const organs = policy.organs && typeof policy.organs === 'object' ? Object.keys(policy.organs) : [];
  const rows = organs.map((organId) => {
    const state = keyring.organs && keyring.organs[organId] ? keyring.organs[organId] : null;
    const activeVersion = clampInt(state && state.active_version, 1, 1_000_000, 1);
    const activeRec = state && state.versions ? state.versions[String(activeVersion)] : null;
    const rotatedAt = cleanText(
      activeRec && (activeRec.rotated_at || activeRec.created_at) || '',
      40
    );
    const ageDays = rotatedAt
      ? Math.max(0, Math.floor((now - Date.parse(rotatedAt)) / 86400000))
      : null;
    return {
      organ_id: organId,
      active_version: state ? activeVersion : null,
      version_count: state && state.versions && typeof state.versions === 'object'
        ? Object.keys(state.versions).length
        : 0,
      key_rotation_age_days: ageDays,
      stale_rotation: typeof ageDays === 'number' ? ageDays > Number(policy.max_rotation_age_days || 0) : true
    };
  });
  const stale = rows.filter((row) => row.stale_rotation === true).map((row) => row.organ_id);
  return {
    ok: stale.length === 0,
    type: 'organ_state_encryption_status',
    ts: nowIso(),
    policy_path: rel(policy.policy_path),
    unauthorized_fail_closed: policy.unauthorized_fail_closed !== false,
    max_rotation_age_days: Number(policy.max_rotation_age_days || 0),
    lane_roots: {
      state: rel(policy.lane_roots.state),
      memory: rel(policy.lane_roots.memory),
      cryonics: rel(policy.lane_roots.cryonics)
    },
    stale_rotation_organs: stale,
    organs: rows
  };
}

function cmdStatus(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const keyring = loadKeyring(policy);
  bootstrapMissingKeys(policy, keyring);
  const payload = buildStatus(policy, keyring);
  const onlyOrgan = normalizeToken(args.organ || args['organ-id'] || '', 80);
  if (onlyOrgan) {
    payload.organs = payload.organs.filter((row: AnyObj) => row.organ_id === onlyOrgan);
    payload.stale_rotation_organs = payload.stale_rotation_organs.filter((id: string) => id === onlyOrgan);
    payload.ok = payload.stale_rotation_organs.length === 0 && payload.organs.length === 1;
  }
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function cmdVerify(args: AnyObj) {
  const strict = toBool(args.strict, false);
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const keyring = loadKeyring(policy);
  bootstrapMissingKeys(policy, keyring);
  const payload = buildStatus(policy, keyring);
  audit(policy, 'verify', {
    ok: payload.ok === true,
    stale_rotation_organs: payload.stale_rotation_organs
  });
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  if (strict && payload.ok !== true) process.exit(1);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || '', 40);
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'encrypt') return cmdEncrypt(args);
  if (cmd === 'decrypt') return cmdDecrypt(args);
  if (cmd === 'rotate-key') return cmdRotateKey(args);
  if (cmd === 'status') return cmdStatus(args);
  if (cmd === 'verify') return cmdVerify(args);
  usage();
  process.exit(2);
}

if (require.main === module) {
  main();
}

module.exports = {
  loadPolicy,
  loadKeyring,
  buildStatus
};
