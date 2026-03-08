#!/usr/bin/env node
'use strict';
export {};

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

type AnyObj = Record<string, any>;

const ROOT = process.env.EMERGENT_SYNTHESIS_ROOT
  ? path.resolve(process.env.EMERGENT_SYNTHESIS_ROOT)
  : path.resolve(__dirname, '..', '..');

const DEFAULT_POLICY_PATH = process.env.EMERGENT_SYNTHESIS_POLICY_PATH
  ? path.resolve(process.env.EMERGENT_SYNTHESIS_POLICY_PATH)
  : path.join(ROOT, 'config', 'emergent_primitive_synthesis_policy.json');

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

function boolFlag(v: unknown, fallback = false) {
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

function usage() {
  console.log('Usage:');
  console.log('  node systems/primitives/emergent_primitive_synthesis.js propose --name=<primitive_name> --intent="..." [--source=forge|inversion|research] [--objective-id=<id>] [--policy=<path>]');
  console.log('  node systems/primitives/emergent_primitive_synthesis.js evaluate --candidate-id=<id> [--nursery-pass=1|0] [--adversarial-pass=1|0] [--policy=<path>]');
  console.log('  node systems/primitives/emergent_primitive_synthesis.js approve --candidate-id=<id> --approved-by=<id> --approval-note="..." [--policy=<path>]');
  console.log('  node systems/primitives/emergent_primitive_synthesis.js reject --candidate-id=<id> --lesson="..." [--policy=<path>]');
  console.log('  node systems/primitives/emergent_primitive_synthesis.js promote --candidate-id=<id> [--apply=1|0] [--policy=<path>]');
  console.log('  node systems/primitives/emergent_primitive_synthesis.js status [--policy=<path>]');
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

function resolvePath(rawPath: unknown) {
  const text = cleanText(rawPath || '', 400);
  if (!text) return ROOT;
  return path.isAbsolute(text) ? text : path.join(ROOT, text);
}

function rel(absPath: string) {
  return path.relative(ROOT, absPath).replace(/\\/g, '/');
}

function defaultPolicy() {
  return {
    schema_id: 'emergent_primitive_synthesis_policy',
    schema_version: '1.0',
    enabled: true,
    max_open_candidates: 64,
    require_nursery_pass: true,
    require_adversarial_pass: true,
    require_invariant_pass: true,
    require_human_approval: true,
    allow_auto_promotion: false,
    min_lesson_length: 12,
    allowed_sources: ['forge', 'inversion', 'research'],
    candidates_path: 'state/primitives/synthesis/candidates.json',
    archive_path: 'state/primitives/synthesis/archive.jsonl',
    promotions_path: 'state/primitives/synthesis/promotions.jsonl',
    receipts_path: 'state/primitives/synthesis/receipts.jsonl',
    invariant_check_command: ['node', 'systems/security/formal_invariant_engine.js', 'run', '--strict=1']
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const base = defaultPolicy();
  const raw = readJson(policyPath, {});
  const invariantCmd = Array.isArray(raw.invariant_check_command)
    ? raw.invariant_check_command.map((v: unknown) => cleanText(v, 240)).filter(Boolean)
    : base.invariant_check_command;
  const sources = Array.isArray(raw.allowed_sources)
    ? raw.allowed_sources.map((v: unknown) => normalizeToken(v, 80)).filter(Boolean)
    : base.allowed_sources;

  return {
    schema_id: 'emergent_primitive_synthesis_policy',
    schema_version: cleanText(raw.schema_version || base.schema_version, 32) || base.schema_version,
    enabled: raw.enabled !== false,
    max_open_candidates: clampInt(raw.max_open_candidates, 1, 10000, base.max_open_candidates),
    require_nursery_pass: raw.require_nursery_pass !== false,
    require_adversarial_pass: raw.require_adversarial_pass !== false,
    require_invariant_pass: raw.require_invariant_pass !== false,
    require_human_approval: raw.require_human_approval !== false,
    allow_auto_promotion: raw.allow_auto_promotion === true,
    min_lesson_length: clampInt(raw.min_lesson_length, 1, 200, base.min_lesson_length),
    allowed_sources: sources.length ? sources : base.allowed_sources,
    candidates_path: resolvePath(raw.candidates_path || base.candidates_path),
    archive_path: resolvePath(raw.archive_path || base.archive_path),
    promotions_path: resolvePath(raw.promotions_path || base.promotions_path),
    receipts_path: resolvePath(raw.receipts_path || base.receipts_path),
    invariant_check_command: invariantCmd.length ? invariantCmd : base.invariant_check_command,
    policy_path: path.resolve(policyPath)
  };
}

function loadCandidates(policy: AnyObj) {
  const state = readJson(policy.candidates_path, {
    schema_id: 'emergent_primitive_candidates',
    schema_version: '1.0',
    updated_at: null,
    candidates: {}
  });
  const candidates = state.candidates && typeof state.candidates === 'object' ? state.candidates : {};
  return {
    schema_id: 'emergent_primitive_candidates',
    schema_version: '1.0',
    updated_at: cleanText(state.updated_at || '', 40) || null,
    candidates
  };
}

function writeCandidates(policy: AnyObj, state: AnyObj) {
  state.updated_at = nowIso();
  writeJsonAtomic(policy.candidates_path, state);
}

function writeReceipt(policy: AnyObj, row: AnyObj) {
  appendJsonl(policy.receipts_path, {
    ts: nowIso(),
    policy_version: policy.schema_version,
    policy_path: rel(policy.policy_path),
    ...row
  });
}

function candidateId(seed: string) {
  return `synth_${crypto.createHash('sha1').update(seed).digest('hex').slice(0, 12)}`;
}

function openCandidateCount(state: AnyObj) {
  return Object.values(state.candidates || {}).filter((row: AnyObj) => {
    const status = normalizeToken(row && row.status ? row.status : '', 40);
    return status && !['rejected', 'archived', 'promotion_proposed', 'promoted'].includes(status);
  }).length;
}

function archiveCandidate(policy: AnyObj, candidate: AnyObj, reason: string, lessons: string[]) {
  appendJsonl(policy.archive_path, {
    type: 'emergent_primitive_archive',
    ts: nowIso(),
    candidate_id: candidate.candidate_id,
    primitive_name: candidate.primitive_name,
    reason: cleanText(reason, 80),
    lessons
  });
}

function runInvariantCheck(policy: AnyObj) {
  const mock = normalizeToken(process.env.EMERGENT_SYNTHESIS_MOCK_INVARIANT || '', 24);
  if (mock === 'pass') {
    return { ok: true, command: 'mock:pass', status: 0, stdout: 'mock_pass', stderr: '' };
  }
  if (mock === 'fail') {
    return { ok: false, command: 'mock:fail', status: 1, stdout: '', stderr: 'mock_fail' };
  }

  const cmd = Array.isArray(policy.invariant_check_command) ? policy.invariant_check_command.slice() : [];
  if (!cmd.length) return { ok: false, command: 'missing', status: 1, stdout: '', stderr: 'invariant_command_missing' };
  const binary = String(cmd.shift() || '');
  const r = spawnSync(binary, cmd, {
    cwd: ROOT,
    encoding: 'utf8'
  });
  return {
    ok: Number(r.status || 0) === 0,
    command: [binary, ...cmd].join(' '),
    status: Number(r.status || 0),
    stdout: String(r.stdout || '').trim(),
    stderr: String(r.stderr || '').trim()
  };
}

function cmdPropose(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  if (policy.enabled !== true) {
    process.stdout.write(`${JSON.stringify({ ok: false, reason: 'policy_disabled' }, null, 2)}\n`);
    process.exit(1);
  }

  const primitiveName = normalizeToken(args.name || args.primitive || '', 80);
  const intent = cleanText(args.intent || args.description || '', 500);
  const source = normalizeToken(args.source || 'forge', 80);
  const objectiveId = cleanText(args['objective-id'] || args.objective_id || '', 120) || null;

  if (!primitiveName || !intent) {
    process.stdout.write(`${JSON.stringify({ ok: false, reason: 'name_and_intent_required' }, null, 2)}\n`);
    process.exit(2);
  }
  if (!policy.allowed_sources.includes(source)) {
    process.stdout.write(`${JSON.stringify({ ok: false, reason: 'source_not_allowed', source, allowed_sources: policy.allowed_sources }, null, 2)}\n`);
    process.exit(2);
  }

  const state = loadCandidates(policy);
  if (openCandidateCount(state) >= policy.max_open_candidates) {
    process.stdout.write(`${JSON.stringify({ ok: false, reason: 'open_candidate_cap_reached', cap: policy.max_open_candidates }, null, 2)}\n`);
    process.exit(1);
  }

  const seed = `${primitiveName}|${intent}|${source}|${Date.now()}`;
  const id = candidateId(seed);
  const candidate = {
    candidate_id: id,
    primitive_name: primitiveName,
    intent,
    source,
    objective_id: objectiveId,
    status: 'proposed',
    nursery_only: true,
    proposed_at: nowIso(),
    updated_at: nowIso(),
    checks: {
      nursery_pass: null,
      adversarial_pass: null,
      invariant_pass: null
    },
    proof_refs: {
      nursery_receipt: cleanText(args['nursery-receipt'] || '', 240) || null,
      adversarial_receipt: cleanText(args['adversarial-receipt'] || '', 240) || null,
      invariant_receipt: null
    },
    human_gate: null,
    lessons: []
  };

  state.candidates[id] = candidate;
  writeCandidates(policy, state);
  writeReceipt(policy, {
    type: 'emergent_primitive_proposed',
    candidate_id: id,
    primitive_name: primitiveName,
    source,
    objective_id: objectiveId,
    nursery_only: true
  });

  process.stdout.write(`${JSON.stringify({ ok: true, type: 'emergent_primitive_proposed', candidate }, null, 2)}\n`);
}

function getCandidateOrExit(state: AnyObj, candidateIdRaw: unknown) {
  const candidateIdValue = cleanText(candidateIdRaw || '', 120);
  const candidate = state.candidates[candidateIdValue];
  if (!candidate) {
    process.stdout.write(`${JSON.stringify({ ok: false, reason: 'candidate_not_found', candidate_id: candidateIdValue }, null, 2)}\n`);
    process.exit(1);
  }
  return { candidateId: candidateIdValue, candidate };
}

function cmdEvaluate(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const state = loadCandidates(policy);
  const row = getCandidateOrExit(state, args['candidate-id'] || args.candidate_id);
  const candidate = row.candidate;
  const status = normalizeToken(candidate.status || '', 40);
  if (!['proposed', 'evaluating'].includes(status)) {
    process.stdout.write(`${JSON.stringify({ ok: false, reason: 'candidate_not_evaluable', candidate_id: row.candidateId, status }, null, 2)}\n`);
    process.exit(1);
  }

  const invariantResult = runInvariantCheck(policy);
  const nurseryPass = boolFlag(args['nursery-pass'], false);
  const adversarialPass = boolFlag(args['adversarial-pass'], false);
  const lessons: string[] = [];

  if (policy.require_invariant_pass && invariantResult.ok !== true) lessons.push('invariant_check_failed');
  if (policy.require_nursery_pass && nurseryPass !== true) lessons.push('nursery_validation_failed');
  if (policy.require_adversarial_pass && adversarialPass !== true) lessons.push('adversarial_validation_failed');

  candidate.checks = {
    nursery_pass: nurseryPass,
    adversarial_pass: adversarialPass,
    invariant_pass: invariantResult.ok === true
  };
  candidate.proof_refs = {
    ...candidate.proof_refs,
    nursery_receipt: cleanText(args['nursery-receipt'] || candidate.proof_refs.nursery_receipt || '', 240) || null,
    adversarial_receipt: cleanText(args['adversarial-receipt'] || candidate.proof_refs.adversarial_receipt || '', 240) || null,
    invariant_receipt: invariantResult.command
  };

  let outStatus = 'awaiting_human_gate';
  if (lessons.length) {
    outStatus = 'rejected';
    candidate.lessons = Array.from(new Set([...(Array.isArray(candidate.lessons) ? candidate.lessons : []), ...lessons]));
    archiveCandidate(policy, candidate, 'evaluation_failed', candidate.lessons);
  }

  candidate.status = outStatus;
  candidate.updated_at = nowIso();
  state.candidates[row.candidateId] = candidate;
  writeCandidates(policy, state);

  writeReceipt(policy, {
    type: 'emergent_primitive_evaluated',
    candidate_id: row.candidateId,
    status: outStatus,
    invariant_ok: invariantResult.ok === true,
    invariant_command: invariantResult.command,
    nursery_pass: nurseryPass,
    adversarial_pass: adversarialPass,
    lessons
  });

  process.stdout.write(`${JSON.stringify({
    ok: outStatus !== 'rejected',
    type: 'emergent_primitive_evaluated',
    candidate_id: row.candidateId,
    status: outStatus,
    lessons,
    invariant: {
      ok: invariantResult.ok === true,
      command: invariantResult.command,
      status: invariantResult.status
    }
  }, null, 2)}\n`);
  if (outStatus === 'rejected') process.exit(1);
}

function cmdApprove(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const state = loadCandidates(policy);
  const row = getCandidateOrExit(state, args['candidate-id'] || args.candidate_id);
  const candidate = row.candidate;
  const status = normalizeToken(candidate.status || '', 40);
  if (status !== 'awaiting_human_gate') {
    process.stdout.write(`${JSON.stringify({ ok: false, reason: 'candidate_not_ready_for_approval', candidate_id: row.candidateId, status }, null, 2)}\n`);
    process.exit(1);
  }

  const approvedBy = normalizeToken(args['approved-by'] || args.approved_by || '', 120);
  const approvalNote = cleanText(args['approval-note'] || args.approval_note || '', 400);
  if (!approvedBy || !approvalNote) {
    process.stdout.write(`${JSON.stringify({ ok: false, reason: 'approved_by_and_note_required' }, null, 2)}\n`);
    process.exit(2);
  }

  candidate.status = 'approved';
  candidate.human_gate = {
    approved_by: approvedBy,
    approval_note: approvalNote,
    approved_at: nowIso()
  };
  candidate.updated_at = nowIso();
  state.candidates[row.candidateId] = candidate;
  writeCandidates(policy, state);

  writeReceipt(policy, {
    type: 'emergent_primitive_approved',
    candidate_id: row.candidateId,
    approved_by: approvedBy
  });
  process.stdout.write(`${JSON.stringify({ ok: true, type: 'emergent_primitive_approved', candidate_id: row.candidateId }, null, 2)}\n`);
}

function cmdReject(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const state = loadCandidates(policy);
  const row = getCandidateOrExit(state, args['candidate-id'] || args.candidate_id);
  const candidate = row.candidate;
  const lesson = cleanText(args.lesson || '', 400);
  if (lesson.length < policy.min_lesson_length) {
    process.stdout.write(`${JSON.stringify({ ok: false, reason: 'lesson_too_short', min_lesson_length: policy.min_lesson_length }, null, 2)}\n`);
    process.exit(2);
  }

  candidate.status = 'rejected';
  candidate.updated_at = nowIso();
  candidate.lessons = Array.from(new Set([...(Array.isArray(candidate.lessons) ? candidate.lessons : []), lesson]));
  state.candidates[row.candidateId] = candidate;
  writeCandidates(policy, state);
  archiveCandidate(policy, candidate, 'manual_reject', candidate.lessons);

  writeReceipt(policy, {
    type: 'emergent_primitive_rejected',
    candidate_id: row.candidateId,
    lesson
  });
  process.stdout.write(`${JSON.stringify({ ok: true, type: 'emergent_primitive_rejected', candidate_id: row.candidateId }, null, 2)}\n`);
}

function cmdPromote(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const state = loadCandidates(policy);
  const row = getCandidateOrExit(state, args['candidate-id'] || args.candidate_id);
  const candidate = row.candidate;
  const status = normalizeToken(candidate.status || '', 40);

  if (policy.require_human_approval && status !== 'approved') {
    process.stdout.write(`${JSON.stringify({ ok: false, reason: 'human_approval_required', candidate_id: row.candidateId, status }, null, 2)}\n`);
    process.exit(1);
  }

  const apply = boolFlag(args.apply, false);
  const promoted = policy.allow_auto_promotion === true && apply === true;
  const promotionId = `promo_${crypto.createHash('sha1').update(`${row.candidateId}|${Date.now()}`).digest('hex').slice(0, 12)}`;

  appendJsonl(policy.promotions_path, {
    type: 'emergent_primitive_promotion_proposal',
    ts: nowIso(),
    promotion_id: promotionId,
    candidate_id: row.candidateId,
    primitive_name: candidate.primitive_name,
    source: candidate.source,
    objective_id: candidate.objective_id || null,
    apply_requested: apply,
    promoted,
    candidate_snapshot: {
      checks: candidate.checks || {},
      proof_refs: candidate.proof_refs || {},
      human_gate: candidate.human_gate || null,
      lessons: candidate.lessons || []
    }
  });

  candidate.status = promoted ? 'promoted' : 'promotion_proposed';
  candidate.updated_at = nowIso();
  candidate.promotion_id = promotionId;
  state.candidates[row.candidateId] = candidate;
  writeCandidates(policy, state);

  writeReceipt(policy, {
    type: 'emergent_primitive_promote',
    candidate_id: row.candidateId,
    promotion_id: promotionId,
    promoted,
    apply_requested: apply
  });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'emergent_primitive_promote',
    candidate_id: row.candidateId,
    promotion_id: promotionId,
    promoted,
    apply_requested: apply,
    status: candidate.status
  }, null, 2)}\n`);
}

function cmdStatus(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const state = loadCandidates(policy);
  const rows = Object.values(state.candidates || {}) as AnyObj[];
  const byStatus: AnyObj = {};
  for (const row of rows) {
    const status = normalizeToken(row && row.status ? row.status : '', 40) || 'unknown';
    byStatus[status] = Number(byStatus[status] || 0) + 1;
  }

  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'emergent_primitive_synthesis_status',
    ts: nowIso(),
    policy_path: rel(policy.policy_path),
    candidates_path: rel(policy.candidates_path),
    archive_path: rel(policy.archive_path),
    promotions_path: rel(policy.promotions_path),
    receipts_path: rel(policy.receipts_path),
    candidate_count: rows.length,
    open_candidate_count: openCandidateCount(state),
    by_status: byStatus
  }, null, 2)}\n`);
}

function main(argv: string[]) {
  const args = parseArgs(argv);
  const cmd = String(args._[0] || '').trim().toLowerCase();
  if (!cmd || cmd === 'help' || cmd === '--help' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'propose') return cmdPropose(args);
  if (cmd === 'evaluate') return cmdEvaluate(args);
  if (cmd === 'approve') return cmdApprove(args);
  if (cmd === 'reject') return cmdReject(args);
  if (cmd === 'promote') return cmdPromote(args);
  if (cmd === 'status') return cmdStatus(args);
  usage();
  process.exit(2);
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = {
  DEFAULT_POLICY_PATH,
  loadPolicy,
  loadCandidates,
  runInvariantCheck
};
