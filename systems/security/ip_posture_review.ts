#!/usr/bin/env node
'use strict';
export {};

/**
 * ip_posture_review.js
 *
 * SEC-M05 governance lane: trade-secret/provisional-patent posture tracking.
 */

const path = require('path');
const {
  ROOT,
  nowIso,
  parseArgs,
  cleanText,
  normalizeToken,
  toBool,
  clampInt,
  readJson,
  writeJsonAtomic,
  appendJsonl,
  resolvePath,
  emit,
  stableHash
} = require('../../lib/queued_backlog_runtime');

const DEFAULT_POLICY_PATH = process.env.IP_POSTURE_REVIEW_POLICY_PATH
  ? path.resolve(process.env.IP_POSTURE_REVIEW_POLICY_PATH)
  : path.join(ROOT, 'config', 'ip_posture_review_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/security/ip_posture_review.js draft [--apply=1|0] [--policy=<path>]');
  console.log('  node systems/security/ip_posture_review.js evidence-pack [--apply=1|0] [--policy=<path>]');
  console.log('  node systems/security/ip_posture_review.js record-counsel --counsel=<name> --decision=approve|revise|hold --approval-note="..." [--firm=<name>] [--apply=1|0] [--policy=<path>]');
  console.log('  node systems/security/ip_posture_review.js status [--strict=1|0] [--policy=<path>]');
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    shadow_only: true,
    strict_default: false,
    min_approval_note_chars: 8,
    paths: {
      latest_path: 'state/security/ip_posture_review/latest.json',
      receipts_path: 'state/security/ip_posture_review/receipts.jsonl',
      counsel_records_path: 'state/security/ip_posture_review/counsel_records.json',
      evidence_pack_path: 'state/security/ip_posture_review/evidence_pack.json',
      invention_register_path: 'state/security/ip_posture_review/invention_register.json',
      strategy_doc_path: 'docs/IP_POSTURE_REVIEW.md'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  return {
    version: cleanText(raw.version || base.version, 32),
    enabled: toBool(raw.enabled, true),
    shadow_only: toBool(raw.shadow_only, true),
    strict_default: toBool(raw.strict_default, base.strict_default),
    min_approval_note_chars: clampInt(raw.min_approval_note_chars, 4, 400, base.min_approval_note_chars),
    paths: {
      latest_path: resolvePath(paths.latest_path, base.paths.latest_path),
      receipts_path: resolvePath(paths.receipts_path, base.paths.receipts_path),
      counsel_records_path: resolvePath(paths.counsel_records_path, base.paths.counsel_records_path),
      evidence_pack_path: resolvePath(paths.evidence_pack_path, base.paths.evidence_pack_path),
      invention_register_path: resolvePath(paths.invention_register_path, base.paths.invention_register_path),
      strategy_doc_path: resolvePath(paths.strategy_doc_path, base.paths.strategy_doc_path)
    }
  };
}

function loadCounselRecords(policy) {
  const payload = readJson(policy.paths.counsel_records_path, { records: [] });
  const records = Array.isArray(payload.records) ? payload.records : [];
  return records.filter((row) => row && typeof row === 'object');
}

function saveCounselRecords(policy, records) {
  writeJsonAtomic(policy.paths.counsel_records_path, {
    schema_id: 'ip_posture_counsel_records',
    schema_version: '1.0',
    updated_at: nowIso(),
    records
  });
}

function loadInventionRegister(policy) {
  const fallback = {
    schema_id: 'ip_invention_register',
    schema_version: '1.0',
    updated_at: nowIso(),
    inventions: [
      {
        id: 'inv-helix-sentinel-lane',
        area: 'security',
        strategy: 'trade_secret',
        description: 'Helix/Sentinel attestation, quarantine, and adaptive defense flow.'
      },
      {
        id: 'inv-state-kernel-hybrid-plane',
        area: 'state',
        strategy: 'trade_secret',
        description: 'Hybrid mutable-state kernel with deterministic event evidence lanes.'
      },
      {
        id: 'inv-symbiosis-gated-recursion',
        area: 'alignment',
        strategy: 'provisional_patent_candidate',
        description: 'Symbiosis-score gated recursion depth and constitutional escalation controls.'
      }
    ]
  };
  return readJson(policy.paths.invention_register_path, fallback);
}

function persistLatest(policy, row) {
  writeJsonAtomic(policy.paths.latest_path, row);
  appendJsonl(policy.paths.receipts_path, row);
}

function draftPolicy(args, policy) {
  const apply = toBool(args.apply, false);
  const register = loadInventionRegister(policy);
  if (apply) {
    writeJsonAtomic(policy.paths.invention_register_path, register);
  }
  const out = {
    ok: true,
    type: 'ip_posture_draft',
    ts: nowIso(),
    apply,
    shadow_only: policy.shadow_only,
    invention_count: Array.isArray(register.inventions) ? register.inventions.length : 0,
    strategy_doc_path: path.relative(ROOT, policy.paths.strategy_doc_path).replace(/\\/g, '/'),
    invention_register_path: path.relative(ROOT, policy.paths.invention_register_path).replace(/\\/g, '/')
  };
  persistLatest(policy, out);
  return out;
}

function evidencePack(args, policy) {
  const apply = toBool(args.apply, false);
  const register = loadInventionRegister(policy);
  const records = loadCounselRecords(policy);
  const pack = {
    schema_id: 'ip_posture_evidence_pack',
    schema_version: '1.0',
    generated_at: nowIso(),
    strategy_doc_path: path.relative(ROOT, policy.paths.strategy_doc_path).replace(/\\/g, '/'),
    invention_register_path: path.relative(ROOT, policy.paths.invention_register_path).replace(/\\/g, '/'),
    counsel_records_path: path.relative(ROOT, policy.paths.counsel_records_path).replace(/\\/g, '/'),
    evidence_hash: stableHash(JSON.stringify({ register, records }), 32),
    invention_count: Array.isArray(register.inventions) ? register.inventions.length : 0,
    counsel_record_count: records.length
  };
  if (apply) writeJsonAtomic(policy.paths.evidence_pack_path, pack);
  const out = {
    ok: true,
    type: 'ip_posture_evidence_pack',
    ts: nowIso(),
    apply,
    evidence_pack_path: path.relative(ROOT, policy.paths.evidence_pack_path).replace(/\\/g, '/'),
    evidence_hash: pack.evidence_hash,
    invention_count: pack.invention_count,
    counsel_record_count: pack.counsel_record_count
  };
  persistLatest(policy, out);
  return out;
}

function recordCounsel(args, policy) {
  const apply = toBool(args.apply, true);
  const counsel = cleanText(args.counsel || '', 120);
  const firm = cleanText(args.firm || 'unspecified', 120);
  const decision = normalizeToken(args.decision || '', 40);
  const approvalNote = cleanText(args['approval-note'] || args.approval_note || '', 500);
  if (!counsel || !decision || !approvalNote) {
    return {
      ok: false,
      type: 'ip_posture_record_counsel',
      error: 'counsel_decision_approval_note_required'
    };
  }
  if (!['approve', 'revise', 'hold'].includes(decision)) {
    return {
      ok: false,
      type: 'ip_posture_record_counsel',
      error: 'invalid_decision'
    };
  }
  if (approvalNote.length < policy.min_approval_note_chars) {
    return {
      ok: false,
      type: 'ip_posture_record_counsel',
      error: 'approval_note_too_short'
    };
  }

  const records = loadCounselRecords(policy);
  const row = {
    ts: nowIso(),
    counsel,
    firm,
    decision,
    approval_note: approvalNote,
    record_id: `ipr_${stableHash(`${Date.now()}|${counsel}|${decision}`, 12)}`
  };
  const next = records.concat([row]).slice(-200);
  if (apply) saveCounselRecords(policy, next);

  const out = {
    ok: true,
    type: 'ip_posture_record_counsel',
    ts: nowIso(),
    apply,
    record: row,
    total_records: next.length,
    counsel_records_path: path.relative(ROOT, policy.paths.counsel_records_path).replace(/\\/g, '/')
  };
  persistLatest(policy, out);
  return out;
}

function status(args, policy) {
  const strict = args.strict != null ? toBool(args.strict, false) : policy.strict_default;
  const latest = readJson(policy.paths.latest_path, {});
  const records = loadCounselRecords(policy);
  const register = loadInventionRegister(policy);
  const evidence = readJson(policy.paths.evidence_pack_path, {});
  const strategyDocExists = (() => {
    try { return require('fs').existsSync(policy.paths.strategy_doc_path); } catch { return false; }
  })();

  const checks = {
    strategy_doc_present: strategyDocExists,
    invention_register_present: Array.isArray(register.inventions) && register.inventions.length > 0,
    evidence_pack_present: evidence && typeof evidence === 'object' && !!evidence.evidence_hash,
    counsel_review_present: records.length > 0,
    counsel_decision_actionable: records.some((row) => ['approve', 'revise'].includes(normalizeToken(row && row.decision || '', 40)))
  };
  const pass = Object.values(checks).every(Boolean);

  const out = {
    ok: strict ? pass : true,
    type: 'ip_posture_status',
    ts: nowIso(),
    strict,
    shadow_only: policy.shadow_only,
    pass,
    checks,
    metrics: {
      counsel_records: records.length,
      inventions: Array.isArray(register.inventions) ? register.inventions.length : 0,
      latest_decision: records.length ? normalizeToken(records[records.length - 1].decision || '', 40) : null
    },
    paths: {
      strategy_doc_path: path.relative(ROOT, policy.paths.strategy_doc_path).replace(/\\/g, '/'),
      invention_register_path: path.relative(ROOT, policy.paths.invention_register_path).replace(/\\/g, '/'),
      evidence_pack_path: path.relative(ROOT, policy.paths.evidence_pack_path).replace(/\\/g, '/'),
      counsel_records_path: path.relative(ROOT, policy.paths.counsel_records_path).replace(/\\/g, '/')
    },
    latest
  };
  persistLatest(policy, out);
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || 'status', 80) || 'status';
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    usage();
    return;
  }

  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  if (!policy.enabled) emit({ ok: false, error: 'ip_posture_review_disabled' }, 1);

  if (cmd === 'draft') emit(draftPolicy(args, policy));
  if (cmd === 'evidence-pack') emit(evidencePack(args, policy));
  if (cmd === 'record-counsel') emit(recordCounsel(args, policy));
  if (cmd === 'status') {
    const out = status(args, policy);
    if (out.ok !== true) emit(out, 1);
    emit(out);
  }

  usage();
  process.exit(1);
}

main();
