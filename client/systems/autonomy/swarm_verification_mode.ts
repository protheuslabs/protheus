#!/usr/bin/env node
'use strict';
export {};

/**
 * BL-011
 * Swarm verification mode for deep-thinker decisions.
 *
 * Usage:
 *   node systems/autonomy/swarm_verification_mode.js verify --proposal-json="{...}" --votes-json="[...]" [--tokens=<n>] [--strict=1|0]
 *   node systems/autonomy/swarm_verification_mode.js status
 */

const fs = require('fs');
const path = require('path');

type AnyObj = Record<string, any>;

const ROOT = process.env.SWARM_VERIFY_ROOT
  ? path.resolve(process.env.SWARM_VERIFY_ROOT)
  : path.resolve(__dirname, '..', '..');

const DEFAULT_POLICY_PATH = process.env.SWARM_VERIFY_POLICY_PATH
  ? path.resolve(process.env.SWARM_VERIFY_POLICY_PATH)
  : path.join(ROOT, 'config', 'swarm_verification_mode_policy.json');

function nowIso() { return new Date().toISOString(); }
function cleanText(v: unknown, maxLen = 360) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}
function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const tok = String(argv[i] || '');
    if (!tok.startsWith('--')) { out._.push(tok); continue; }
    const eq = tok.indexOf('=');
    if (eq >= 0) { out[tok.slice(2, eq)] = tok.slice(eq + 1); continue; }
    const key = tok.slice(2);
    const next = argv[i + 1];
    if (next != null && !String(next).startsWith('--')) { out[key] = String(next); i += 1; continue; }
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
function clampNumber(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}
function ensureDir(dirPath: string) { fs.mkdirSync(dirPath, { recursive: true }); }
function readJson(filePath: string, fallback: any = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed == null ? fallback : parsed;
  } catch { return fallback; }
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
function resolvePath(raw: unknown, fallbackRel: string) {
  const txt = cleanText(raw, 520);
  if (!txt) return path.join(ROOT, fallbackRel);
  return path.isAbsolute(txt) ? txt : path.join(ROOT, txt);
}
function rel(filePath: string) { return path.relative(ROOT, filePath).replace(/\\/g, '/'); }
function parseJsonArg(raw: unknown, fallback: any = null) {
  const txt = cleanText(raw, 50000);
  if (!txt) return fallback;
  try { return JSON.parse(txt); } catch { return fallback; }
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    quorum: {
      min_votes: 3,
      min_agreement_ratio: 0.67,
      min_avg_confidence: 0.6
    },
    budget: {
      max_tokens_per_verification: 12000
    },
    outputs: {
      latest_path: 'state/autonomy/swarm_verification_mode/latest.json',
      history_path: 'state/autonomy/swarm_verification_mode/history.jsonl'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const base = defaultPolicy();
  const raw = readJson(policyPath, {});
  const quorum = raw.quorum && typeof raw.quorum === 'object' ? raw.quorum : {};
  const budget = raw.budget && typeof raw.budget === 'object' ? raw.budget : {};
  const outputs = raw.outputs && typeof raw.outputs === 'object' ? raw.outputs : {};
  return {
    version: cleanText(raw.version || base.version, 40) || base.version,
    enabled: raw.enabled !== false,
    quorum: {
      min_votes: Math.max(1, Number(quorum.min_votes || base.quorum.min_votes)),
      min_agreement_ratio: clampNumber(quorum.min_agreement_ratio, 0.5, 1, base.quorum.min_agreement_ratio),
      min_avg_confidence: clampNumber(quorum.min_avg_confidence, 0, 1, base.quorum.min_avg_confidence)
    },
    budget: {
      max_tokens_per_verification: Math.max(1, Number(budget.max_tokens_per_verification || base.budget.max_tokens_per_verification))
    },
    outputs: {
      latest_path: resolvePath(outputs.latest_path, base.outputs.latest_path),
      history_path: resolvePath(outputs.history_path, base.outputs.history_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function normalizeVotes(rows: unknown) {
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row: AnyObj) => ({
      model: cleanText(row && row.model, 120),
      verdict: cleanText(row && row.verdict, 40).toLowerCase(),
      confidence: clampNumber(row && row.confidence, 0, 1, 0)
    }))
    .filter((row: AnyObj) => row.model && (row.verdict === 'approve' || row.verdict === 'reject'));
}

function cmdVerify(args: AnyObj) {
  const strict = toBool(args.strict, true);
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  if (!policy.enabled) return { ok: true, strict, result: 'disabled_by_policy', policy_path: rel(policy.policy_path) };

  const proposal = parseJsonArg(args['proposal-json'] || args.proposal_json || '', {});
  const votes = normalizeVotes(parseJsonArg(args['votes-json'] || args.votes_json || '', []));
  const tokens = Math.max(0, Number(args.tokens || 0));

  const voteCount = votes.length;
  const approveVotes = votes.filter((v: AnyObj) => v.verdict === 'approve').length;
  const rejectVotes = votes.filter((v: AnyObj) => v.verdict === 'reject').length;
  const agreement = voteCount > 0 ? Math.max(approveVotes, rejectVotes) / voteCount : 0;
  const avgConfidence = voteCount > 0
    ? votes.reduce((s: number, v: AnyObj) => s + Number(v.confidence || 0), 0) / voteCount
    : 0;

  const blockers: AnyObj[] = [];
  if (voteCount < Number(policy.quorum.min_votes || 0)) blockers.push({ gate: 'quorum', reason: 'insufficient_votes' });
  if (agreement < Number(policy.quorum.min_agreement_ratio || 0)) blockers.push({ gate: 'consensus', reason: 'agreement_below_threshold', agreement: Number(agreement.toFixed(4)) });
  if (avgConfidence < Number(policy.quorum.min_avg_confidence || 0)) blockers.push({ gate: 'confidence', reason: 'avg_confidence_below_threshold', avg_confidence: Number(avgConfidence.toFixed(4)) });
  if (tokens > Number(policy.budget.max_tokens_per_verification || 0)) blockers.push({ gate: 'budget', reason: 'verification_token_budget_exceeded', tokens });

  const finalVerdict = approveVotes >= rejectVotes ? 'approve' : 'reject';
  const out = {
    ok: blockers.length === 0,
    ts: nowIso(),
    type: 'swarm_verification_mode',
    strict,
    proposal_id: cleanText(proposal && (proposal.id || proposal.proposal_id), 120) || null,
    final_verdict: finalVerdict,
    metrics: {
      vote_count: voteCount,
      approve_votes: approveVotes,
      reject_votes: rejectVotes,
      agreement_ratio: Number(agreement.toFixed(4)),
      avg_confidence: Number(avgConfidence.toFixed(4)),
      tokens,
      token_cap: Number(policy.budget.max_tokens_per_verification || 0)
    },
    blockers,
    votes,
    policy_path: rel(policy.policy_path)
  };

  writeJsonAtomic(policy.outputs.latest_path, out);
  appendJsonl(policy.outputs.history_path, {
    ts: out.ts,
    type: out.type,
    proposal_id: out.proposal_id,
    final_verdict: out.final_verdict,
    vote_count: out.metrics.vote_count,
    agreement_ratio: out.metrics.agreement_ratio,
    avg_confidence: out.metrics.avg_confidence,
    blocker_count: blockers.length,
    ok: out.ok
  });

  return out;
}

function cmdStatus(args: AnyObj) {
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  return {
    ok: true,
    ts: nowIso(),
    type: 'swarm_verification_mode_status',
    latest_path: rel(policy.outputs.latest_path),
    latest: readJson(policy.outputs.latest_path, null),
    policy_path: rel(policy.policy_path)
  };
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/autonomy/swarm_verification_mode.js verify --proposal-json="{...}" --votes-json="[...]" [--tokens=<n>] [--strict=1|0]');
  console.log('  node systems/autonomy/swarm_verification_mode.js status');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || 'verify').toLowerCase();
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') { usage(); return; }
  try {
    const payload = cmd === 'verify' ? cmdVerify(args)
      : cmd === 'status' ? cmdStatus(args)
      : { ok: false, error: `unknown_command:${cmd}` };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    if (payload.ok === false && toBool(args.strict, true)) process.exit(1);
    if (payload.ok === false) process.exit(1);
  } catch (err) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: cleanText((err as AnyObj)?.message || err || 'swarm_verification_mode_failed', 260) })}\n`);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { loadPolicy, cmdVerify, cmdStatus };
