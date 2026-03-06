#!/usr/bin/env node
'use strict';
export {};

/**
 * remote_tamper_heartbeat.js
 *
 * V3-026: signed heartbeat attestation + rogue/divergence detection and
 * automatic quarantine transitions with evidence + operator notifications.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { verifyIntegrity } = require('../../lib/security_integrity');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = process.env.REMOTE_TAMPER_HEARTBEAT_POLICY_PATH
  ? path.resolve(String(process.env.REMOTE_TAMPER_HEARTBEAT_POLICY_PATH))
  : path.join(ROOT, 'config', 'remote_tamper_heartbeat_policy.json');

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
    if (idx < 0) out[String(tok || '').slice(2)] = true;
    else out[String(tok || '').slice(2, idx)] = String(tok || '').slice(idx + 1);
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

function sha256Hex(buf: Buffer | string) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function defaultPolicy() {
  return {
    schema_id: 'remote_tamper_heartbeat_policy',
    schema_version: '1.0',
    enabled: true,
    mode: 'enforce',
    heartbeat_interval_sec: 60,
    max_silence_sec: 180,
    integrity_probe_enabled: true,
    auto_quarantine_on_anomaly: true,
    signature_required: true,
    allow_auto_generated_local_key: true,
    static_watermark: 'protheus-local',
    identity_drift_allowed: false,
    secrets: {
      signing_key_env: 'PROTHEUS_HEARTBEAT_SIGNING_KEY',
      signing_key_path: 'state/security/remote_tamper_heartbeat/signing_key.txt'
    },
    paths: {
      state_path: 'state/security/remote_tamper_heartbeat/state.json',
      latest_path: 'state/security/remote_tamper_heartbeat/latest.json',
      outbox_path: 'state/security/remote_tamper_heartbeat/outbox.jsonl',
      notifications_path: 'state/security/remote_tamper_heartbeat/notifications.jsonl',
      quarantine_path: 'state/security/remote_tamper_heartbeat/quarantine.json',
      evidence_dir: 'state/security/remote_tamper_heartbeat/evidence'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const base = defaultPolicy();
  const raw = readJson(policyPath, {});
  const secretsRaw = raw.secrets && typeof raw.secrets === 'object' ? raw.secrets : {};
  const pathsRaw = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  return {
    schema_id: 'remote_tamper_heartbeat_policy',
    schema_version: cleanText(raw.schema_version || base.schema_version, 24) || base.schema_version,
    enabled: raw.enabled !== false,
    mode: ['enforce', 'advisory'].includes(normalizeToken(raw.mode || '', 20))
      ? normalizeToken(raw.mode || '', 20)
      : base.mode,
    heartbeat_interval_sec: clampInt(raw.heartbeat_interval_sec, 5, 3600, base.heartbeat_interval_sec),
    max_silence_sec: clampInt(raw.max_silence_sec, 10, 86400, base.max_silence_sec),
    integrity_probe_enabled: raw.integrity_probe_enabled !== false,
    auto_quarantine_on_anomaly: raw.auto_quarantine_on_anomaly !== false,
    signature_required: raw.signature_required !== false,
    allow_auto_generated_local_key: raw.allow_auto_generated_local_key !== false,
    static_watermark: cleanText(raw.static_watermark || base.static_watermark, 200) || base.static_watermark,
    identity_drift_allowed: raw.identity_drift_allowed === true,
    secrets: {
      signing_key_env: cleanText(secretsRaw.signing_key_env || base.secrets.signing_key_env, 120) || base.secrets.signing_key_env,
      signing_key_path: resolvePath(secretsRaw.signing_key_path, base.secrets.signing_key_path)
    },
    paths: {
      state_path: resolvePath(pathsRaw.state_path, base.paths.state_path),
      latest_path: resolvePath(pathsRaw.latest_path, base.paths.latest_path),
      outbox_path: resolvePath(pathsRaw.outbox_path, base.paths.outbox_path),
      notifications_path: resolvePath(pathsRaw.notifications_path, base.paths.notifications_path),
      quarantine_path: resolvePath(pathsRaw.quarantine_path, base.paths.quarantine_path),
      evidence_dir: resolvePath(pathsRaw.evidence_dir, base.paths.evidence_dir)
    },
    policy_path: path.resolve(policyPath)
  };
}

function loadState(policy: AnyObj) {
  const raw = readJson(policy.paths.state_path, {});
  return {
    schema_id: 'remote_tamper_heartbeat_state',
    schema_version: '1.0',
    updated_at: cleanText(raw.updated_at || nowIso(), 40) || nowIso(),
    trusted_identity: raw.trusted_identity && typeof raw.trusted_identity === 'object' ? raw.trusted_identity : null,
    last_heartbeat_id: cleanText(raw.last_heartbeat_id || '', 120) || null,
    last_heartbeat_ts: cleanText(raw.last_heartbeat_ts || '', 40) || null,
    consecutive_anomalies: clampInt(raw.consecutive_anomalies, 0, 1000000, 0)
  };
}

function saveState(policy: AnyObj, state: AnyObj) {
  writeJsonAtomic(policy.paths.state_path, {
    schema_id: 'remote_tamper_heartbeat_state',
    schema_version: '1.0',
    updated_at: nowIso(),
    trusted_identity: state.trusted_identity || null,
    last_heartbeat_id: state.last_heartbeat_id || null,
    last_heartbeat_ts: state.last_heartbeat_ts || null,
    consecutive_anomalies: clampInt(state.consecutive_anomalies, 0, 1000000, 0)
  });
}

function loadSigningKey(policy: AnyObj) {
  const envName = policy.secrets.signing_key_env;
  const envKey = cleanText(process.env[envName] || '', 10000);
  if (envKey) return { key: envKey, source: `env:${envName}`, generated: false };
  if (fs.existsSync(policy.secrets.signing_key_path)) {
    const fileKey = cleanText(fs.readFileSync(policy.secrets.signing_key_path, 'utf8'), 10000);
    if (fileKey) return { key: fileKey, source: `file:${rel(policy.secrets.signing_key_path)}`, generated: false };
  }
  if (policy.allow_auto_generated_local_key !== true) return { key: '', source: 'missing', generated: false };
  const generated = crypto.randomBytes(32).toString('hex');
  ensureDir(path.dirname(policy.secrets.signing_key_path));
  fs.writeFileSync(policy.secrets.signing_key_path, `${generated}\n`, { encoding: 'utf8', mode: 0o600 });
  return { key: generated, source: `generated:${rel(policy.secrets.signing_key_path)}`, generated: true };
}

function signPayload(payload: AnyObj, secret: string) {
  return crypto.createHmac('sha256', secret).update(JSON.stringify(payload), 'utf8').digest('hex');
}

function verifySignature(payload: AnyObj, signature: string, secret: string) {
  const expected = signPayload(payload, secret);
  return expected === String(signature || '');
}

function loadLatest(policy: AnyObj) {
  return readJson(policy.paths.latest_path, null);
}

function loadQuarantine(policy: AnyObj) {
  const raw = readJson(policy.paths.quarantine_path, {});
  return {
    schema_id: 'remote_tamper_quarantine',
    schema_version: '1.0',
    active: raw.active === true,
    reason: cleanText(raw.reason || '', 200) || null,
    activated_at: cleanText(raw.activated_at || '', 40) || null,
    released_at: cleanText(raw.released_at || '', 40) || null,
    evidence_bundle: cleanText(raw.evidence_bundle || '', 300) || null
  };
}

function saveQuarantine(policy: AnyObj, payload: AnyObj) {
  writeJsonAtomic(policy.paths.quarantine_path, {
    schema_id: 'remote_tamper_quarantine',
    schema_version: '1.0',
    active: payload.active === true,
    reason: cleanText(payload.reason || '', 200) || null,
    activated_at: cleanText(payload.activated_at || '', 40) || null,
    released_at: cleanText(payload.released_at || '', 40) || null,
    evidence_bundle: cleanText(payload.evidence_bundle || '', 300) || null
  });
}

function computeConstitutionHash() {
  const dir = path.join(ROOT, 'config', 'directives');
  const files: string[] = [];
  function walk(absDir: string) {
    if (!fs.existsSync(absDir)) return;
    const entries = fs.readdirSync(absDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const ent of entries) {
      const abs = path.join(absDir, ent.name);
      if (ent.isDirectory()) walk(abs);
      else if (ent.isFile()) files.push(abs);
    }
  }
  walk(dir);
  const hash = crypto.createHash('sha256');
  for (const file of files) {
    hash.update(rel(file));
    hash.update('\n');
    hash.update(fs.readFileSync(file));
    hash.update('\n');
  }
  return hash.digest('hex');
}

function readGitHead() {
  try {
    const head = fs.readFileSync(path.join(ROOT, '.git', 'HEAD'), 'utf8').trim();
    if (!head) return 'unknown';
    if (head.startsWith('ref:')) {
      const ref = head.slice(4).trim();
      const refPath = path.join(ROOT, '.git', ref);
      if (fs.existsSync(refPath)) return cleanText(fs.readFileSync(refPath, 'utf8'), 64) || 'unknown';
    }
    return cleanText(head, 64) || 'unknown';
  } catch {
    return 'unknown';
  }
}

function buildHeartbeat(policy: AnyObj, args: AnyObj = {}) {
  const id = `hb_${sha256Hex(`${nowIso()}|${Math.random()}|${process.pid}`).slice(0, 20)}`;
  const watermark = cleanText(args.watermark || process.env.PROTHEUS_WATERMARK || policy.static_watermark, 200) || policy.static_watermark;
  const buildId = cleanText(args['build-id'] || process.env.PROTHEUS_BUILD_ID || readGitHead(), 120) || 'unknown';
  const constitutionHash = computeConstitutionHash();
  let integrity: AnyObj = { ok: true, violation_counts: {} };
  if (policy.integrity_probe_enabled === true) {
    const probe = verifyIntegrity();
    integrity = {
      ok: probe && probe.ok === true,
      violation_counts: probe && probe.violation_counts && typeof probe.violation_counts === 'object'
        ? probe.violation_counts
        : {}
    };
  }
  return {
    heartbeat_id: id,
    ts: nowIso(),
    instance_id: cleanText(os.hostname(), 120) || 'unknown',
    pid: Number(process.pid || 0),
    mode: policy.mode,
    build_id: buildId,
    watermark,
    constitution_hash: constitutionHash,
    integrity_ok: integrity.ok === true,
    integrity_violation_counts: integrity.violation_counts || {}
  };
}

function evaluateAnomalies(policy: AnyObj, state: AnyObj, heartbeat: AnyObj, signingKeyPresent: boolean) {
  const reasons: string[] = [];
  if (policy.signature_required === true && !signingKeyPresent) reasons.push('signing_key_missing');
  if (heartbeat.integrity_ok !== true) reasons.push('integrity_probe_failed');

  if (!state.trusted_identity || typeof state.trusted_identity !== 'object') {
    state.trusted_identity = {
      build_id: heartbeat.build_id,
      watermark: heartbeat.watermark,
      constitution_hash: heartbeat.constitution_hash,
      pinned_at: nowIso()
    };
  } else if (policy.identity_drift_allowed !== true) {
    if (cleanText(state.trusted_identity.build_id || '', 120) !== cleanText(heartbeat.build_id || '', 120)) {
      reasons.push('trusted_build_id_mismatch');
    }
    if (cleanText(state.trusted_identity.watermark || '', 200) !== cleanText(heartbeat.watermark || '', 200)) {
      reasons.push('trusted_watermark_mismatch');
    }
    if (cleanText(state.trusted_identity.constitution_hash || '', 200) !== cleanText(heartbeat.constitution_hash || '', 200)) {
      reasons.push('trusted_constitution_hash_mismatch');
    }
  }
  return Array.from(new Set(reasons));
}

function persistHeartbeat(policy: AnyObj, signed: AnyObj) {
  appendJsonl(policy.paths.outbox_path, {
    type: 'remote_tamper_heartbeat',
    ...signed
  });
  writeJsonAtomic(policy.paths.latest_path, {
    type: 'remote_tamper_heartbeat',
    ...signed
  });
}

function persistEvidence(policy: AnyObj, evidence: AnyObj, heartbeatId: string) {
  ensureDir(policy.paths.evidence_dir);
  const fp = path.join(policy.paths.evidence_dir, `${heartbeatId}.json`);
  writeJsonAtomic(fp, evidence);
  return fp;
}

function notify(policy: AnyObj, row: AnyObj) {
  appendJsonl(policy.paths.notifications_path, {
    ts: nowIso(),
    type: 'remote_tamper_notification',
    ...row
  });
}

function cmdEmit(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const state = loadState(policy);
  const keyInfo = loadSigningKey(policy);
  const heartbeat = buildHeartbeat(policy, args);
  const anomalies = evaluateAnomalies(policy, state, heartbeat, !!keyInfo.key);
  const signature = keyInfo.key ? signPayload(heartbeat, keyInfo.key) : null;
  const signed = {
    ...heartbeat,
    anomalies,
    anomaly: anomalies.length > 0,
    signature,
    signature_alg: 'hmac-sha256'
  };
  persistHeartbeat(policy, signed);

  state.last_heartbeat_id = signed.heartbeat_id;
  state.last_heartbeat_ts = signed.ts;
  state.consecutive_anomalies = signed.anomaly ? Number(state.consecutive_anomalies || 0) + 1 : 0;
  saveState(policy, state);

  const evidenceBundle = {
    schema_id: 'remote_tamper_evidence_bundle',
    schema_version: '1.0',
    ts: nowIso(),
    heartbeat: signed,
    trusted_identity: state.trusted_identity || null,
    signing_key_source: keyInfo.source,
    mode: policy.mode
  };
  const evidencePath = persistEvidence(policy, evidenceBundle, signed.heartbeat_id);
  const quarantine = loadQuarantine(policy);
  if (signed.anomaly && policy.auto_quarantine_on_anomaly === true) {
    saveQuarantine(policy, {
      active: true,
      reason: anomalies.join('|') || 'anomaly_detected',
      activated_at: nowIso(),
      released_at: null,
      evidence_bundle: rel(evidencePath)
    });
    notify(policy, {
      severity: 'high',
      action: 'quarantine_activated',
      heartbeat_id: signed.heartbeat_id,
      anomaly_reasons: anomalies,
      evidence_bundle: rel(evidencePath)
    });
  } else {
    notify(policy, {
      severity: 'info',
      action: 'heartbeat_emitted',
      heartbeat_id: signed.heartbeat_id,
      anomaly_reasons: anomalies,
      evidence_bundle: rel(evidencePath)
    });
  }

  const out = {
    ok: true,
    type: 'remote_tamper_heartbeat_emit',
    heartbeat_id: signed.heartbeat_id,
    anomaly: signed.anomaly,
    anomaly_reasons: anomalies,
    signature_present: !!signature,
    signing_key_source: keyInfo.source,
    evidence_bundle: rel(evidencePath),
    quarantine_active: loadQuarantine(policy).active === true
  };
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

function cmdClearQuarantine(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const reason = cleanText(args.reason || 'manual_release', 180) || 'manual_release';
  saveQuarantine(policy, {
    active: false,
    reason,
    activated_at: null,
    released_at: nowIso(),
    evidence_bundle: null
  });
  notify(policy, {
    severity: 'info',
    action: 'quarantine_cleared',
    reason
  });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'remote_tamper_quarantine_cleared',
    reason
  }, null, 2)}\n`);
}

function cmdStatus(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const latest = loadLatest(policy);
  const quarantine = loadQuarantine(policy);
  const state = loadState(policy);
  const out = {
    ok: true,
    type: 'remote_tamper_heartbeat_status',
    ts: nowIso(),
    policy_path: rel(policy.policy_path),
    latest: latest || null,
    quarantine,
    trusted_identity: state.trusted_identity || null,
    consecutive_anomalies: Number(state.consecutive_anomalies || 0),
    paths: {
      latest_path: rel(policy.paths.latest_path),
      outbox_path: rel(policy.paths.outbox_path),
      notifications_path: rel(policy.paths.notifications_path),
      quarantine_path: rel(policy.paths.quarantine_path),
      evidence_dir: rel(policy.paths.evidence_dir)
    }
  };
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

function cmdVerify(args: AnyObj) {
  const strict = toBool(args.strict, false);
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  let latest = loadLatest(policy);
  if (!latest || typeof latest !== 'object') {
    cmdEmit({ ...args, 'build-id': args['build-id'] || null, watermark: args.watermark || null });
    latest = loadLatest(policy);
  }
  const keyInfo = loadSigningKey(policy);
  const state = loadState(policy);
  const quarantine = loadQuarantine(policy);
  const now = Date.now();
  const ageSec = latest && latest.ts ? Math.max(0, Math.floor((now - Date.parse(String(latest.ts))) / 1000)) : null;
  const signatureOk = keyInfo.key && latest && latest.signature
    ? verifySignature({
      heartbeat_id: latest.heartbeat_id,
      ts: latest.ts,
      instance_id: latest.instance_id,
      pid: latest.pid,
      mode: latest.mode,
      build_id: latest.build_id,
      watermark: latest.watermark,
      constitution_hash: latest.constitution_hash,
      integrity_ok: latest.integrity_ok,
      integrity_violation_counts: latest.integrity_violation_counts
    }, String(latest.signature || ''), keyInfo.key)
    : false;
  const reasons: string[] = [];
  if (policy.signature_required === true && !signatureOk) reasons.push('signature_invalid');
  if (typeof ageSec === 'number' && ageSec > Number(policy.max_silence_sec || 0)) reasons.push('heartbeat_stale');
  if (latest && latest.anomaly === true && policy.auto_quarantine_on_anomaly === true && quarantine.active !== true) {
    reasons.push('quarantine_not_active_on_anomaly');
  }
  if (state.trusted_identity && typeof state.trusted_identity === 'object' && policy.identity_drift_allowed !== true) {
    if (cleanText(state.trusted_identity.build_id || '', 120) !== cleanText(latest && latest.build_id || '', 120)) {
      reasons.push('trusted_build_id_mismatch');
    }
    if (cleanText(state.trusted_identity.watermark || '', 200) !== cleanText(latest && latest.watermark || '', 200)) {
      reasons.push('trusted_watermark_mismatch');
    }
    if (cleanText(state.trusted_identity.constitution_hash || '', 200) !== cleanText(latest && latest.constitution_hash || '', 200)) {
      reasons.push('trusted_constitution_hash_mismatch');
    }
  }
  const out = {
    ok: reasons.length === 0,
    type: 'remote_tamper_heartbeat_verify',
    ts: nowIso(),
    latest_heartbeat_id: latest && latest.heartbeat_id || null,
    heartbeat_age_sec: ageSec,
    signature_ok: signatureOk,
    quarantine_active: quarantine.active === true,
    reasons
  };
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  if (strict && out.ok !== true) process.exit(1);
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/security/remote_tamper_heartbeat.js emit [--build-id=<id>] [--watermark=<value>]');
  console.log('  node systems/security/remote_tamper_heartbeat.js verify [--strict=1|0]');
  console.log('  node systems/security/remote_tamper_heartbeat.js clear-quarantine [--reason=<text>]');
  console.log('  node systems/security/remote_tamper_heartbeat.js status');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || '', 40);
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'emit') return cmdEmit(args);
  if (cmd === 'verify') return cmdVerify(args);
  if (cmd === 'clear-quarantine') return cmdClearQuarantine(args);
  if (cmd === 'status') return cmdStatus(args);
  usage();
  process.exit(2);
}

if (require.main === module) {
  main();
}

module.exports = {
  loadPolicy,
  loadState,
  buildHeartbeat
};
