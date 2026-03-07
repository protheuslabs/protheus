#!/usr/bin/env node
'use strict';
export {};

/**
 * operator_terms_ack.js
 *
 * SEC-M04: versioned operator ToS/EULA acknowledgment lane.
 *
 * Usage:
 *   node systems/security/operator_terms_ack.js check [--strict=1|0]
 *   node systems/security/operator_terms_ack.js accept --operator-id=<id> [--approval-note="..."] [--apply=1|0]
 *   node systems/security/operator_terms_ack.js status
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = process.env.OPERATOR_TERMS_ACK_POLICY_PATH
  ? path.resolve(String(process.env.OPERATOR_TERMS_ACK_POLICY_PATH))
  : path.join(ROOT, 'config', 'operator_terms_ack_policy.json');

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
  for (let i = 0; i < argv.length; i += 1) {
    const tok = String(argv[i] || '');
    if (!tok.startsWith('--')) {
      out._.push(tok);
      continue;
    }
    const idx = tok.indexOf('=');
    if (idx >= 0) {
      out[tok.slice(2, idx)] = tok.slice(idx + 1);
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
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
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

function fileSha256OrNull(absPath: string) {
  try {
    if (!fs.existsSync(absPath)) return null;
    if (!fs.statSync(absPath).isFile()) return null;
    return crypto.createHash('sha256').update(fs.readFileSync(absPath)).digest('hex');
  } catch {
    return null;
  }
}

function defaultPolicy() {
  return {
    schema_id: 'operator_terms_ack_policy',
    schema_version: '1.0',
    enabled: true,
    enforce_on_install: true,
    current_terms_version: '2026-02-27.v1',
    paths: {
      tos_path: 'TERMS_OF_SERVICE.md',
      eula_path: 'EULA.md',
      state_path: 'state/security/operator_terms_ack/state.json',
      latest_path: 'state/security/operator_terms_ack/latest.json',
      receipts_path: 'state/security/operator_terms_ack/receipts.jsonl'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const base = defaultPolicy();
  const raw = readJson(policyPath, {});
  const pathsRaw = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  return {
    schema_id: 'operator_terms_ack_policy',
    schema_version: cleanText(raw.schema_version || base.schema_version, 24) || base.schema_version,
    enabled: raw.enabled !== false,
    enforce_on_install: raw.enforce_on_install !== false,
    current_terms_version: cleanText(raw.current_terms_version || base.current_terms_version, 80) || base.current_terms_version,
    paths: {
      tos_path: resolvePath(pathsRaw.tos_path, base.paths.tos_path),
      eula_path: resolvePath(pathsRaw.eula_path, base.paths.eula_path),
      state_path: resolvePath(pathsRaw.state_path, base.paths.state_path),
      latest_path: resolvePath(pathsRaw.latest_path, base.paths.latest_path),
      receipts_path: resolvePath(pathsRaw.receipts_path, base.paths.receipts_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function computeTermsFingerprint(policy: AnyObj) {
  const tosPath = policy.paths.tos_path;
  const eulaPath = policy.paths.eula_path;
  const tosSha = fileSha256OrNull(tosPath);
  const eulaSha = fileSha256OrNull(eulaPath);
  return {
    tos_path: tosPath,
    eula_path: eulaPath,
    tos_exists: !!tosSha,
    eula_exists: !!eulaSha,
    tos_sha256: tosSha,
    eula_sha256: eulaSha
  };
}

function loadState(policy: AnyObj) {
  const raw = readJson(policy.paths.state_path, {});
  return {
    schema_id: 'operator_terms_ack_state',
    schema_version: '1.0',
    accepted: raw.accepted === true,
    terms_version: cleanText(raw.terms_version || '', 80) || null,
    tos_sha256: cleanText(raw.tos_sha256 || '', 128) || null,
    eula_sha256: cleanText(raw.eula_sha256 || '', 128) || null,
    operator_id: normalizeToken(raw.operator_id || '', 120) || null,
    approval_note: cleanText(raw.approval_note || '', 240) || null,
    accepted_at: cleanText(raw.accepted_at || '', 40) || null,
    host: cleanText(raw.host || '', 200) || null
  };
}

function checkAcceptance(policy: AnyObj, state: AnyObj, fingerprint: AnyObj) {
  const reasons: string[] = [];
  if (policy.enabled !== true) return { ok: true, accepted: true, reasons };
  if (!fingerprint.tos_exists) reasons.push('tos_missing');
  if (!fingerprint.eula_exists) reasons.push('eula_missing');
  if (state.accepted !== true) reasons.push('operator_ack_missing');
  if (state.terms_version !== policy.current_terms_version) reasons.push('terms_version_mismatch');
  if (state.tos_sha256 && fingerprint.tos_sha256 && state.tos_sha256 !== fingerprint.tos_sha256) reasons.push('tos_digest_mismatch');
  if (state.eula_sha256 && fingerprint.eula_sha256 && state.eula_sha256 !== fingerprint.eula_sha256) reasons.push('eula_digest_mismatch');
  return {
    ok: reasons.length === 0,
    accepted: reasons.length === 0,
    reasons
  };
}

function cmdCheck(args: AnyObj) {
  const policy = loadPolicy(args.policy);
  const strict = toBool(args.strict, false);
  const fingerprint = computeTermsFingerprint(policy);
  const state = loadState(policy);
  const result = checkAcceptance(policy, state, fingerprint);
  const out = {
    ok: result.ok,
    type: 'operator_terms_ack_check',
    ts: nowIso(),
    enabled: policy.enabled === true,
    enforce_on_install: policy.enforce_on_install === true,
    current_terms_version: policy.current_terms_version,
    accepted: result.accepted === true,
    reasons: result.reasons,
    fingerprint: {
      tos_path: rel(fingerprint.tos_path),
      eula_path: rel(fingerprint.eula_path),
      tos_exists: fingerprint.tos_exists,
      eula_exists: fingerprint.eula_exists,
      tos_sha256: fingerprint.tos_sha256,
      eula_sha256: fingerprint.eula_sha256
    },
    state: {
      terms_version: state.terms_version,
      accepted: state.accepted === true,
      operator_id: state.operator_id,
      accepted_at: state.accepted_at
    }
  };
  writeJsonAtomic(policy.paths.latest_path, out);
  if (strict && !out.ok) process.exitCode = 1;
  return out;
}

function cmdAccept(args: AnyObj) {
  const policy = loadPolicy(args.policy);
  const apply = toBool(args.apply, true);
  const operatorId = normalizeToken(
    args['operator-id'] || args.operator_id || process.env.USER || os.hostname(),
    120
  ) || 'unknown_operator';
  const approvalNote = cleanText(args['approval-note'] || args.approval_note || '', 240) || null;
  const fingerprint = computeTermsFingerprint(policy);
  const reasons: string[] = [];
  if (!fingerprint.tos_exists) reasons.push('tos_missing');
  if (!fingerprint.eula_exists) reasons.push('eula_missing');
  const acceptedAt = nowIso();
  const record = {
    schema_id: 'operator_terms_ack_state',
    schema_version: '1.0',
    accepted: reasons.length === 0,
    terms_version: policy.current_terms_version,
    tos_sha256: fingerprint.tos_sha256,
    eula_sha256: fingerprint.eula_sha256,
    operator_id: operatorId,
    approval_note: approvalNote,
    accepted_at: acceptedAt,
    host: cleanText(os.hostname(), 200) || null
  };
  const out = {
    ok: reasons.length === 0,
    type: 'operator_terms_ack_accept',
    ts: acceptedAt,
    applied: apply === true,
    current_terms_version: policy.current_terms_version,
    reasons,
    record
  };
  if (apply === true) {
    writeJsonAtomic(policy.paths.state_path, record);
    writeJsonAtomic(policy.paths.latest_path, out);
    appendJsonl(policy.paths.receipts_path, {
      ts: acceptedAt,
      type: 'operator_terms_ack_receipt',
      ok: out.ok === true,
      terms_version: policy.current_terms_version,
      operator_id: operatorId,
      approval_note: approvalNote,
      tos_sha256: fingerprint.tos_sha256,
      eula_sha256: fingerprint.eula_sha256,
      reasons
    });
  }
  return out;
}

function cmdStatus(args: AnyObj) {
  const policy = loadPolicy(args.policy);
  const state = loadState(policy);
  const latest = readJson(policy.paths.latest_path, null);
  return {
    ok: true,
    type: 'operator_terms_ack_status',
    ts: nowIso(),
    enabled: policy.enabled === true,
    enforce_on_install: policy.enforce_on_install === true,
    current_terms_version: policy.current_terms_version,
    accepted: state.accepted === true && state.terms_version === policy.current_terms_version,
    state,
    latest: latest && typeof latest === 'object' ? latest : null,
    paths: {
      policy_path: rel(policy.policy_path),
      state_path: rel(policy.paths.state_path),
      latest_path: rel(policy.paths.latest_path),
      receipts_path: rel(policy.paths.receipts_path),
      tos_path: rel(policy.paths.tos_path),
      eula_path: rel(policy.paths.eula_path)
    }
  };
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/security/operator_terms_ack.js check [--strict=1|0]');
  console.log('  node systems/security/operator_terms_ack.js accept --operator-id=<id> [--approval-note="..."] [--apply=1|0]');
  console.log('  node systems/security/operator_terms_ack.js status');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || '', 40);
  let out: AnyObj;
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || args.help) {
    usage();
    return;
  }
  if (cmd === 'check') out = cmdCheck(args);
  else if (cmd === 'accept') out = cmdAccept(args);
  else if (cmd === 'status') out = cmdStatus(args);
  else out = { ok: false, type: 'operator_terms_ack', error: `unknown_command:${cmd}` };
  process.stdout.write(`${JSON.stringify(out)}\n`);
  const strictCheck = cmd === 'check' && toBool(args.strict, false);
  if (out && out.ok === false && (!strictCheck ? cmd !== 'check' : true)) process.exitCode = 1;
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      type: 'operator_terms_ack',
      error: cleanText((err as AnyObj)?.message || err || 'operator_terms_ack_failed', 260)
    })}\n`);
    process.exit(1);
  }
}

module.exports = {
  loadPolicy,
  computeTermsFingerprint,
  loadState,
  checkAcceptance,
  cmdCheck,
  cmdAccept,
  cmdStatus
};
