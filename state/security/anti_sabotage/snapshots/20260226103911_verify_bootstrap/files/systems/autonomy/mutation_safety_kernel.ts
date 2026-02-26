#!/usr/bin/env node
'use strict';

/**
 * mutation_safety_kernel.js
 *
 * Expanded adaptive mutation safety envelope:
 * - branch-level risk scoring
 * - mutation-rate control
 * - staged promotion bands
 * - high-impact dual-control + policy-root evidence requirements
 *
 * Usage:
 *   node systems/autonomy/mutation_safety_kernel.js evaluate --proposal-file=/abs/path.json
 *   node systems/autonomy/mutation_safety_kernel.js status
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const POLICY_PATH = process.env.MUTATION_SAFETY_KERNEL_POLICY_PATH
  ? path.resolve(process.env.MUTATION_SAFETY_KERNEL_POLICY_PATH)
  : path.join(ROOT, 'config', 'mutation_safety_kernel_policy.json');
const RUNS_DIR = process.env.MUTATION_SAFETY_RUNS_DIR
  ? path.resolve(process.env.MUTATION_SAFETY_RUNS_DIR)
  : path.join(ROOT, 'state', 'autonomy', 'runs');
const STATE_DIR = process.env.MUTATION_SAFETY_STATE_DIR
  ? path.resolve(process.env.MUTATION_SAFETY_STATE_DIR)
  : path.join(ROOT, 'state', 'autonomy', 'mutation_safety_kernel');
const HISTORY_PATH = path.join(STATE_DIR, 'history.jsonl');

const MUTATION_SIGNAL_RE = /(adaptive|mutation|topology|genome|fractal|morph|rewire|spawn|self[_-]?improv|branch[_-]?(?:spawn|rewire|prune))/i;

function nowIso() {
  return new Date().toISOString();
}

function todayStr() {
  return nowIso().slice(0, 10);
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/autonomy/mutation_safety_kernel.js evaluate --proposal-file=/abs/path.json');
  console.log('  node systems/autonomy/mutation_safety_kernel.js status');
}

function parseArgs(argv) {
  const out = { _: [] };
  for (const arg of argv) {
    if (!arg.startsWith('--')) {
      out._.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq === -1) out[arg.slice(2)] = true;
    else out[arg.slice(2, eq)] = arg.slice(eq + 1);
  }
  return out;
}

function normalizeText(v, maxLen = 240) {
  return String(v == null ? '' : v).trim().slice(0, maxLen);
}

function normalizeToken(v, maxLen = 80) {
  return normalizeText(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function clampInt(v, lo, hi, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function readJsonl(filePath) {
  try {
    if (!fs.existsSync(filePath)) return [];
    return fs.readFileSync(filePath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function appendJsonl(filePath, row) {
  ensureDir(filePath);
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function relPath(p) {
  return path.relative(ROOT, p).replace(/\\/g, '/');
}

function defaultPolicy() {
  return {
    version: '1.0',
    max_mutation_attempts_per_day: 4,
    high_risk_score_min: 70,
    medium_risk_score_min: 45,
    require_lineage_id: true,
    require_policy_root_for_high: true,
    require_dual_control_for_high: true
  };
}

function loadPolicy(policyPath = POLICY_PATH) {
  const src = readJson(policyPath, {});
  const base = defaultPolicy();
  return {
    version: normalizeText(src.version || base.version, 32) || '1.0',
    max_mutation_attempts_per_day: clampInt(src.max_mutation_attempts_per_day, 1, 1000, base.max_mutation_attempts_per_day),
    high_risk_score_min: clampInt(src.high_risk_score_min, 1, 100, base.high_risk_score_min),
    medium_risk_score_min: clampInt(src.medium_risk_score_min, 1, 100, base.medium_risk_score_min),
    require_lineage_id: src.require_lineage_id !== false,
    require_policy_root_for_high: src.require_policy_root_for_high !== false,
    require_dual_control_for_high: src.require_dual_control_for_high !== false
  };
}

function isMutationProposal(proposal) {
  const p = proposal && typeof proposal === 'object' ? proposal : {};
  const meta = p.meta && typeof p.meta === 'object' ? p.meta : {};
  if (meta.adaptive_mutation === true || meta.mutation_proposal === true || meta.topology_mutation === true) {
    return true;
  }
  const blob = [
    p.type,
    p.title,
    p.summary,
    p.notes,
    p.suggested_next_command,
    p.action_spec && typeof p.action_spec === 'object' ? JSON.stringify(p.action_spec) : '',
    meta && typeof meta === 'object' ? JSON.stringify(meta) : ''
  ].join(' ');
  return MUTATION_SIGNAL_RE.test(String(blob || ''));
}

function todayMutationAttempts() {
  const fp = path.join(RUNS_DIR, `${todayStr()}.jsonl`);
  let count = 0;
  for (const row of readJsonl(fp)) {
    if (!row || row.type !== 'autonomy_run') continue;
    if (MUTATION_SIGNAL_RE.test(String(row.proposal_type || ''))) count += 1;
    else if (MUTATION_SIGNAL_RE.test(String(row.capability_key || ''))) count += 1;
  }
  return count;
}

function computeRiskScore(proposal) {
  const p = proposal && typeof proposal === 'object' ? proposal : {};
  const risk = normalizeToken(p.risk || 'low', 24);
  const meta = p.meta && typeof p.meta === 'object' ? p.meta : {};
  const actionSpec = p.action_spec && typeof p.action_spec === 'object' ? p.action_spec : {};

  let score = 10;
  if (risk === 'medium') score += 25;
  if (risk === 'high') score += 50;

  const blob = String([
    p.type,
    p.title,
    p.summary,
    p.suggested_next_command,
    JSON.stringify(meta),
    JSON.stringify(actionSpec)
  ].join(' ')).toLowerCase();

  if (/\b(policy|governance|integrity|security|kernel)\b/.test(blob)) score += 20;
  if (/\b(spawn|topology|rewire|genome|fractal)\b/.test(blob)) score += 15;
  if (/\b(execute|apply|deploy|merge)\b/.test(blob)) score += 10;
  if (/\bdry[-\s]?run|simulate|canary\b/.test(blob)) score -= 8;

  return Math.max(0, Math.min(100, Math.round(score)));
}

function inferPromotionBand(score, policy) {
  if (score >= policy.high_risk_score_min) return 'high';
  if (score >= policy.medium_risk_score_min) return 'medium';
  return 'low';
}

function evaluateMutationSafetyEnvelope(input = {}) {
  const proposal = input.proposal && typeof input.proposal === 'object' ? input.proposal : {};
  const policy = input.policy && typeof input.policy === 'object' ? input.policy : loadPolicy();
  const applies = isMutationProposal(proposal);
  if (!applies) {
    return {
      applies: false,
      pass: true,
      reason: null,
      reasons: [],
      risk_score: 0,
      promotion_band: 'none',
      controls: {
        attempts_today: todayMutationAttempts(),
        max_attempts_per_day: policy.max_mutation_attempts_per_day
      }
    };
  }

  const reasons = [];
  const meta = proposal.meta && typeof proposal.meta === 'object' ? proposal.meta : {};
  const actionSpec = proposal.action_spec && typeof proposal.action_spec === 'object' ? proposal.action_spec : {};

  const attemptsToday = todayMutationAttempts();
  if (attemptsToday >= policy.max_mutation_attempts_per_day) {
    reasons.push('mutation_rate_daily_cap_exceeded');
  }

  const lineageId = normalizeText(
    meta.mutation_lineage_id
    || meta.lineage_id
    || actionSpec.mutation_lineage_id
    || actionSpec.lineage_id
    || '',
    180
  );
  if (policy.require_lineage_id && !lineageId) reasons.push('mutation_lineage_missing');

  const riskScore = computeRiskScore(proposal);
  const promotionBand = inferPromotionBand(riskScore, policy);

  const policyRootApprovalId = normalizeText(
    meta.policy_root_approval_id
    || actionSpec.policy_root_approval_id
    || '',
    180
  );
  const dualApprovalId = normalizeText(
    meta.dual_approval_id
    || actionSpec.dual_approval_id
    || '',
    180
  );

  if (promotionBand === 'high' && policy.require_policy_root_for_high && !policyRootApprovalId) {
    reasons.push('mutation_high_risk_policy_root_required');
  }
  if (promotionBand === 'high' && policy.require_dual_control_for_high && !dualApprovalId) {
    reasons.push('mutation_high_risk_dual_control_required');
  }

  return {
    applies: true,
    pass: reasons.length === 0,
    reason: reasons[0] || null,
    reasons,
    risk_score: riskScore,
    promotion_band: promotionBand,
    controls: {
      attempts_today: attemptsToday,
      max_attempts_per_day: policy.max_mutation_attempts_per_day,
      lineage_id_present: !!lineageId,
      policy_root_approval_present: !!policyRootApprovalId,
      dual_approval_present: !!dualApprovalId
    }
  };
}

function cmdEvaluate(args) {
  const policy = loadPolicy();
  const proposalPath = normalizeText(args['proposal-file'] || args.proposal_file || '', 400);
  if (!proposalPath) {
    process.stdout.write(JSON.stringify({ ok: false, error: 'proposal_file_required' }) + '\n');
    process.exit(2);
  }
  const proposal = readJson(path.resolve(proposalPath), null);
  if (!proposal || typeof proposal !== 'object') {
    process.stdout.write(JSON.stringify({ ok: false, error: 'proposal_file_invalid' }) + '\n');
    process.exit(2);
  }

  const decision = evaluateMutationSafetyEnvelope({ proposal, policy });
  const out = {
    ok: decision.pass === true,
    type: 'mutation_safety_kernel_decision',
    ts: nowIso(),
    policy_version: policy.version,
    decision
  };
  appendJsonl(HISTORY_PATH, out);
  process.stdout.write(JSON.stringify(out) + '\n');
  if (out.ok !== true) process.exit(1);
}

function cmdStatus() {
  const rows = readJsonl(HISTORY_PATH)
    .filter((row) => row && row.type === 'mutation_safety_kernel_decision')
    .slice(-20);
  const fail = rows.filter((row) => row.ok !== true).length;
  process.stdout.write(JSON.stringify({
    ok: true,
    type: 'mutation_safety_kernel_status',
    ts: nowIso(),
    history_path: relPath(HISTORY_PATH),
    recent_decisions: rows.length,
    recent_failures: fail,
    pass_rate: rows.length > 0 ? Number(((rows.length - fail) / rows.length).toFixed(4)) : null,
    latest: rows.length > 0 ? rows[rows.length - 1] : null
  }) + '\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0], 64);
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'evaluate') return cmdEvaluate(args);
  if (cmd === 'status') return cmdStatus();
  usage();
  process.exit(2);
}

if (require.main === module) {
  main();
}

module.exports = {
  loadPolicy,
  isMutationProposal,
  computeRiskScore,
  evaluateMutationSafetyEnvelope
};
export {};
