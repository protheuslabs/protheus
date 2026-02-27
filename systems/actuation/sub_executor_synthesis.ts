#!/usr/bin/env node
'use strict';
export {};

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const POLICY_PATH = process.env.SUB_EXECUTOR_SYNTHESIS_POLICY_PATH
  ? path.resolve(process.env.SUB_EXECUTOR_SYNTHESIS_POLICY_PATH)
  : path.join(ROOT, 'config', 'sub_executor_synthesis_policy.json');

function nowIso() {
  return new Date().toISOString();
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/actuation/sub_executor_synthesis.js propose --profile-id=<id> --intent=<intent> --failure-reason=<reason> [--risk-class=low|medium|high]');
  console.log('  node systems/actuation/sub_executor_synthesis.js evaluate --candidate-id=<id> [--nursery-pass=1|0] [--adversarial-pass=1|0] [--evidence=<json>]');
  console.log('  node systems/actuation/sub_executor_synthesis.js distill --candidate-id=<id>');
  console.log('  node systems/actuation/sub_executor_synthesis.js gc');
  console.log('  node systems/actuation/sub_executor_synthesis.js status [--candidate-id=<id>]');
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (const token of argv) {
    if (!token.startsWith('--')) {
      out._.push(token);
      continue;
    }
    const idx = token.indexOf('=');
    if (idx < 0) out[token.slice(2)] = true;
    else out[token.slice(2, idx)] = token.slice(idx + 1);
  }
  return out;
}

function cleanText(v: unknown, maxLen = 320) {
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

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath: string, fallback: any) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
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

function parseJsonArg(raw: unknown, fallback: any) {
  const text = cleanText(raw, 20000);
  if (!text) return fallback;
  const payloadText = text.startsWith('@')
    ? fs.readFileSync(path.resolve(text.slice(1)), 'utf8')
    : text;
  try {
    return JSON.parse(payloadText);
  } catch {
    return fallback;
  }
}

function hash12(v: unknown) {
  return crypto.createHash('sha256').update(String(v == null ? '' : v), 'utf8').digest('hex').slice(0, 12);
}

function stableStringify(value: unknown): string {
  if (value == null) return 'null';
  if (Array.isArray(value)) return `[${value.map((row) => stableStringify(row)).join(',')}]`;
  if (typeof value !== 'object') return JSON.stringify(value);
  const obj = value as AnyObj;
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    default_ttl_sec: 6 * 60 * 60,
    max_active_candidates: 128,
    allow_high_risk: false,
    dedupe_window_sec: 60 * 60,
    validation: {
      require_nursery_pass: true,
      require_adversarial_pass: true
    },
    state_path: 'state/actuation/sub_executor_synthesis/state.json',
    receipts_path: 'state/actuation/sub_executor_synthesis/receipts.jsonl',
    distill_dir: 'state/assimilation/capability_profiles/distilled'
  };
}

function loadPolicy(policyPath = POLICY_PATH) {
  const src = readJson(policyPath, {});
  const base = defaultPolicy();
  const validation = src.validation && typeof src.validation === 'object'
    ? src.validation
    : {};
  return {
    version: cleanText(src.version || base.version, 32) || base.version,
    enabled: src.enabled !== false,
    default_ttl_sec: clampInt(src.default_ttl_sec, 60, 30 * 24 * 60 * 60, base.default_ttl_sec),
    max_active_candidates: clampInt(src.max_active_candidates, 1, 10000, base.max_active_candidates),
    allow_high_risk: src.allow_high_risk === true,
    dedupe_window_sec: clampInt(src.dedupe_window_sec, 0, 30 * 24 * 60 * 60, base.dedupe_window_sec),
    validation: {
      require_nursery_pass: toBool(validation.require_nursery_pass, base.validation.require_nursery_pass),
      require_adversarial_pass: toBool(validation.require_adversarial_pass, base.validation.require_adversarial_pass)
    },
    state_path: path.resolve(ROOT, cleanText(src.state_path || base.state_path, 320)),
    receipts_path: path.resolve(ROOT, cleanText(src.receipts_path || base.receipts_path, 320)),
    distill_dir: path.resolve(ROOT, cleanText(src.distill_dir || base.distill_dir, 320))
  };
}

function defaultState() {
  return {
    schema_id: 'sub_executor_synthesis_state',
    schema_version: '1.1',
    updated_at: nowIso(),
    candidates: {}
  };
}

function loadState(policy: AnyObj) {
  const src = readJson(policy.state_path, null);
  if (!src || typeof src !== 'object') return defaultState();
  return {
    schema_id: 'sub_executor_synthesis_state',
    schema_version: '1.1',
    updated_at: cleanText(src.updated_at || nowIso(), 64),
    candidates: src.candidates && typeof src.candidates === 'object' ? src.candidates : {}
  };
}

function saveState(policy: AnyObj, state: AnyObj) {
  writeJsonAtomic(policy.state_path, {
    schema_id: 'sub_executor_synthesis_state',
    schema_version: '1.1',
    updated_at: nowIso(),
    candidates: state && state.candidates && typeof state.candidates === 'object' ? state.candidates : {}
  });
}

function emit(policy: AnyObj, row: AnyObj) {
  appendJsonl(policy.receipts_path, {
    ts: nowIso(),
    ...row
  });
}

function candidateId() {
  const rand = Math.random().toString(36).slice(2, 10);
  return normalizeToken(`ses_${Date.now().toString(36)}_${rand}`, 80);
}

function ttlIso(ttlSec: number) {
  return new Date(Date.now() + (Math.max(1, ttlSec) * 1000)).toISOString();
}

function activeCount(state: AnyObj) {
  return Object.values(state.candidates || {}).filter((row: any) => {
    const status = String(row && row.status || '');
    return status === 'proposed' || status === 'validated';
  }).length;
}

function gcExpired(state: AnyObj) {
  const now = Date.now();
  let expired = 0;
  for (const [id, rowRaw] of Object.entries(state.candidates || {})) {
    const row = rowRaw && typeof rowRaw === 'object' ? rowRaw as AnyObj : {};
    const expires = Date.parse(String(row.expires_at || ''));
    if (!Number.isFinite(expires) || expires > now) continue;
    if (String(row.status || '') === 'expired') continue;
    row.status = 'expired';
    row.updated_at = nowIso();
    state.candidates[id] = row;
    expired += 1;
  }
  return expired;
}

function computeSignature(row: AnyObj) {
  return hash12(stableStringify({
    profile_id: normalizeToken(row.profile_id || '', 160),
    intent: normalizeToken(row.intent || '', 80),
    failure_reason: cleanText(row.failure_reason || '', 200),
    risk_class: normalizeToken(row.risk_class || 'low', 20)
  }));
}

function findRecentCandidateBySignature(state: AnyObj, signature: string, windowSec: number) {
  if (!signature || windowSec <= 0) return null;
  const nowMs = Date.now();
  const windowMs = windowSec * 1000;
  let newest: AnyObj | null = null;
  for (const rowRaw of Object.values(state.candidates || {})) {
    const row = rowRaw && typeof rowRaw === 'object' ? rowRaw as AnyObj : {};
    if (String(row.signature || '') !== signature) continue;
    const status = String(row.status || '');
    if (!['proposed', 'validated'].includes(status)) continue;
    const createdMs = Date.parse(String(row.created_at || ''));
    if (!Number.isFinite(createdMs)) continue;
    if (nowMs - createdMs > windowMs) continue;
    if (!newest) {
      newest = row;
      continue;
    }
    const newestMs = Date.parse(String(newest.created_at || ''));
    if (Number.isFinite(newestMs) && createdMs > newestMs) newest = row;
  }
  return newest;
}

function cmdPropose(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : POLICY_PATH);
  if (!policy.enabled) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'sub_executor_synthesis_propose', error: 'policy_disabled' })}\n`);
    process.exit(1);
  }
  const state = loadState(policy);
  gcExpired(state);
  if (activeCount(state) >= Number(policy.max_active_candidates || 0)) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'sub_executor_synthesis_propose', error: 'max_active_candidates_reached' })}\n`);
    process.exit(1);
  }
  const profileId = normalizeToken(args.profile_id || args['profile-id'] || '', 160);
  const intent = normalizeToken(args.intent || '', 80) || 'unknown_intent';
  const failureReason = cleanText(args.failure_reason || args['failure-reason'] || '', 200);
  const riskClass = normalizeToken(args.risk_class || args['risk-class'] || 'low', 20) || 'low';
  if (!profileId || !failureReason) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'sub_executor_synthesis_propose', error: 'profile_id_and_failure_reason_required' })}\n`);
    process.exit(1);
  }
  if (riskClass === 'high' && policy.allow_high_risk !== true) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'sub_executor_synthesis_propose', error: 'high_risk_not_allowed' })}\n`);
    process.exit(1);
  }

  const signature = computeSignature({ profile_id: profileId, intent, failure_reason: failureReason, risk_class: riskClass });
  const existing = findRecentCandidateBySignature(state, signature, Number(policy.dedupe_window_sec || 0));
  if (existing && existing.candidate_id) {
    existing.expires_at = ttlIso(Number(policy.default_ttl_sec || 0));
    existing.updated_at = nowIso();
    existing.propose_count = Number(existing.propose_count || 1) + 1;
    state.candidates[String(existing.candidate_id)] = existing;
    saveState(policy, state);
    emit(policy, {
      type: 'sub_executor_synthesis_reused',
      candidate_id: existing.candidate_id,
      profile_id: existing.profile_id,
      signature
    });
    process.stdout.write(`${JSON.stringify({ ok: true, type: 'sub_executor_synthesis_propose', reused: true, candidate: existing })}\n`);
    return;
  }

  const id = candidateId();
  const row = {
    candidate_id: id,
    signature,
    profile_id: profileId,
    intent,
    failure_reason: failureReason,
    risk_class: riskClass,
    status: 'proposed',
    primitive_hypothesis: [
      {
        opcode: 'ACTUATION_ADAPTER',
        effect: 'execute',
        notes: 'temporary synthesized edge-case route'
      }
    ],
    validation: null,
    propose_count: 1,
    created_at: nowIso(),
    updated_at: nowIso(),
    expires_at: ttlIso(Number(policy.default_ttl_sec || 0))
  };
  state.candidates[id] = row;
  saveState(policy, state);
  emit(policy, {
    type: 'sub_executor_synthesis_proposed',
    candidate_id: id,
    profile_id: profileId,
    intent,
    risk_class: riskClass,
    signature
  });
  process.stdout.write(`${JSON.stringify({ ok: true, type: 'sub_executor_synthesis_propose', reused: false, candidate: row })}\n`);
}

function cmdEvaluate(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : POLICY_PATH);
  const state = loadState(policy);
  gcExpired(state);
  const id = normalizeToken(args.candidate_id || args['candidate-id'] || '', 80);
  if (!id || !state.candidates[id]) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'sub_executor_synthesis_evaluate', error: 'candidate_not_found' })}\n`);
    process.exit(1);
  }
  const row = state.candidates[id];
  const reasons = [];
  if (!Array.isArray(row.primitive_hypothesis) || row.primitive_hypothesis.length === 0) {
    reasons.push('primitive_hypothesis_missing');
  }
  if (String(row.risk_class || '') === 'high' && policy.allow_high_risk !== true) {
    reasons.push('high_risk_not_allowed');
  }
  const nurseryPass = toBool(args.nursery_pass || args['nursery-pass'], false);
  const adversarialPass = toBool(args.adversarial_pass || args['adversarial-pass'], false);
  if (policy.validation.require_nursery_pass && !nurseryPass) reasons.push('nursery_validation_failed');
  if (policy.validation.require_adversarial_pass && !adversarialPass) reasons.push('adversarial_validation_failed');
  const evidence = parseJsonArg(args.evidence || '', {});
  row.status = reasons.length ? 'rejected' : 'validated';
  row.validation = {
    passed: reasons.length === 0,
    nursery_pass: nurseryPass,
    adversarial_pass: adversarialPass,
    reasons,
    evidence: evidence && typeof evidence === 'object' ? evidence : {}
  };
  row.updated_at = nowIso();
  state.candidates[id] = row;
  saveState(policy, state);
  emit(policy, { type: 'sub_executor_synthesis_evaluated', candidate_id: id, status: row.status, reasons });
  process.stdout.write(`${JSON.stringify({ ok: reasons.length === 0, type: 'sub_executor_synthesis_evaluate', candidate: row })}\n`);
  if (reasons.length) process.exit(1);
}

function cmdDistill(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : POLICY_PATH);
  const state = loadState(policy);
  gcExpired(state);
  const id = normalizeToken(args.candidate_id || args['candidate-id'] || '', 80);
  if (!id || !state.candidates[id]) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'sub_executor_synthesis_distill', error: 'candidate_not_found' })}\n`);
    process.exit(1);
  }
  const row = state.candidates[id];
  if (String(row.status || '') !== 'validated') {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'sub_executor_synthesis_distill', error: 'candidate_not_validated' })}\n`);
    process.exit(1);
  }
  ensureDir(policy.distill_dir);
  const outPath = path.join(policy.distill_dir, `${id}.json`);
  const distilled = {
    schema_id: 'sub_executor_distilled_profile_patch',
    schema_version: '1.1',
    ts: nowIso(),
    candidate_id: id,
    profile_id: String(row.profile_id || ''),
    intent: String(row.intent || ''),
    provenance: {
      source_lane: 'sub_executor_synthesis',
      failure_reason: String(row.failure_reason || ''),
      risk_class: String(row.risk_class || 'low'),
      signature: String(row.signature || '')
    },
    suggested_profile_patch: {
      execution: {
        adapter_kind: 'ACTUATION_ADAPTER'
      },
      intents: [String(row.intent || '')].filter(Boolean)
    }
  };
  writeJsonAtomic(outPath, distilled);
  row.status = 'distilled';
  row.distilled_path = path.relative(ROOT, outPath).replace(/\\/g, '/');
  row.updated_at = nowIso();
  state.candidates[id] = row;
  saveState(policy, state);
  emit(policy, { type: 'sub_executor_synthesis_distilled', candidate_id: id, distilled_path: row.distilled_path });
  process.stdout.write(`${JSON.stringify({ ok: true, type: 'sub_executor_synthesis_distill', candidate: row })}\n`);
}

function cmdGc(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : POLICY_PATH);
  const state = loadState(policy);
  const expired = gcExpired(state);
  saveState(policy, state);
  emit(policy, { type: 'sub_executor_synthesis_gc', expired });
  process.stdout.write(`${JSON.stringify({ ok: true, type: 'sub_executor_synthesis_gc', expired })}\n`);
}

function cmdStatus(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : POLICY_PATH);
  const state = loadState(policy);
  const expired = gcExpired(state);
  saveState(policy, state);
  const id = normalizeToken(args.candidate_id || args['candidate-id'] || '', 80);
  if (id) {
    const row = state.candidates[id] || null;
    if (!row) {
      process.stdout.write(`${JSON.stringify({ ok: false, type: 'sub_executor_synthesis_status', error: 'candidate_not_found', candidate_id: id })}\n`);
      process.exit(1);
    }
    process.stdout.write(`${JSON.stringify({ ok: true, type: 'sub_executor_synthesis_status', candidate: row, expired })}\n`);
    return;
  }
  const rows = Object.values(state.candidates || {});
  const statusCounts: Record<string, number> = {};
  for (const row of rows) {
    const status = normalizeToken(row && row.status, 40) || 'unknown';
    statusCounts[status] = Number(statusCounts[status] || 0) + 1;
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'sub_executor_synthesis_status',
    candidate_count: rows.length,
    active_count: activeCount(state),
    expired,
    status_counts: statusCounts,
    candidates: rows
  })}\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim().toLowerCase();
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'propose') return cmdPropose(args);
  if (cmd === 'evaluate') return cmdEvaluate(args);
  if (cmd === 'distill') return cmdDistill(args);
  if (cmd === 'gc') return cmdGc(args);
  if (cmd === 'status') return cmdStatus(args);
  usage();
  process.exit(2);
}

if (require.main === module) {
  main();
}
