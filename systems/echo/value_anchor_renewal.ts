#!/usr/bin/env node
'use strict';
export {};

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

type AnyObj = Record<string, any>;

const ROOT = process.env.VALUE_ANCHOR_ROOT
  ? path.resolve(process.env.VALUE_ANCHOR_ROOT)
  : path.resolve(__dirname, '..', '..');

const DEFAULT_POLICY_PATH = process.env.VALUE_ANCHOR_POLICY_PATH
  ? path.resolve(process.env.VALUE_ANCHOR_POLICY_PATH)
  : path.join(ROOT, 'config', 'value_anchor_renewal_policy.json');

function nowIso() {
  return new Date().toISOString();
}

function cleanText(v: unknown, maxLen = 400) {
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

function clampNum(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
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
  console.log('  node systems/echo/value_anchor_renewal.js run [--apply=1|0] [--approved-by=<id>] [--approval-note="..."] [--policy=<path>]');
  console.log('  node systems/echo/value_anchor_renewal.js status [--policy=<path>]');
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

function resolvePath(v: unknown) {
  const txt = cleanText(v || '', 500);
  if (!txt) return ROOT;
  return path.isAbsolute(txt) ? txt : path.join(ROOT, txt);
}

function rel(absPath: string) {
  return path.relative(ROOT, absPath).replace(/\\/g, '/');
}

function sha16(v: string) {
  return crypto.createHash('sha256').update(String(v || ''), 'utf8').digest('hex').slice(0, 16);
}

function defaultPolicy() {
  return {
    schema_id: 'value_anchor_renewal_policy',
    schema_version: '1.0',
    enabled: true,
    renewal_interval_days: 14,
    max_auto_shift: 0.08,
    high_impact_shift: 0.15,
    require_user_review_above_shift: true,
    constitution_path: 'AGENT-CONSTITUTION.md',
    first_principles_path: 'state/autonomy/inversion/first_principles.jsonl',
    current_anchor_path: 'state/autonomy/echo/value_anchor/current.json',
    proposals_path: 'state/autonomy/echo/value_anchor/proposals.jsonl',
    history_path: 'state/autonomy/echo/value_anchor/history.jsonl',
    receipts_path: 'state/autonomy/echo/value_anchor/receipts.jsonl'
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const base = defaultPolicy();
  const raw = readJson(policyPath, {});
  return {
    schema_id: 'value_anchor_renewal_policy',
    schema_version: cleanText(raw.schema_version || base.schema_version, 24) || base.schema_version,
    enabled: raw.enabled !== false,
    renewal_interval_days: Math.max(1, Math.floor(Number(raw.renewal_interval_days || base.renewal_interval_days) || base.renewal_interval_days)),
    max_auto_shift: clampNum(raw.max_auto_shift, 0, 1, base.max_auto_shift),
    high_impact_shift: clampNum(raw.high_impact_shift, 0, 1, base.high_impact_shift),
    require_user_review_above_shift: raw.require_user_review_above_shift !== false,
    constitution_path: resolvePath(raw.constitution_path || base.constitution_path),
    first_principles_path: resolvePath(raw.first_principles_path || base.first_principles_path),
    current_anchor_path: resolvePath(raw.current_anchor_path || base.current_anchor_path),
    proposals_path: resolvePath(raw.proposals_path || base.proposals_path),
    history_path: resolvePath(raw.history_path || base.history_path),
    receipts_path: resolvePath(raw.receipts_path || base.receipts_path),
    policy_path: path.resolve(policyPath)
  };
}

function tokenize(text: string) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 4)
    .filter((w) => !['that', 'this', 'with', 'from', 'have', 'there', 'which', 'will', 'about', 'into'].includes(w));
}

function deriveAnchor(policy: AnyObj) {
  const constitution = fs.existsSync(policy.constitution_path)
    ? fs.readFileSync(policy.constitution_path, 'utf8')
    : '';
  const principlesRows = readJsonl(policy.first_principles_path);
  const principlesText = principlesRows
    .map((row: AnyObj) => cleanText(row && (row.principle || row.statement || row.summary || ''), 600))
    .filter(Boolean)
    .join(' ');
  const corpus = `${constitution} ${principlesText}`.trim();
  const counts: AnyObj = {};
  for (const token of tokenize(corpus)) counts[token] = Number(counts[token] || 0) + 1;
  const top = Object.entries(counts)
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .slice(0, 24)
    .map(([k, v]) => ({ token: k, weight: Number(v) }));

  const total = top.reduce((acc, row) => acc + Number(row.weight || 0), 0) || 1;
  const normalized = top.map((row) => ({ token: row.token, weight: Number((Number(row.weight || 0) / total).toFixed(6)) }));
  const anchorText = normalized.map((row) => `${row.token}:${row.weight}`).join('|');
  return {
    anchor_id: `anchor_${sha16(anchorText)}`,
    derived_at: nowIso(),
    token_count: normalized.length,
    weights: normalized,
    sources: {
      constitution_path: rel(policy.constitution_path),
      first_principles_path: rel(policy.first_principles_path)
    }
  };
}

function driftScore(current: AnyObj, proposed: AnyObj) {
  const currentSet = new Set((Array.isArray(current && current.weights) ? current.weights : []).map((row: AnyObj) => String(row.token || '')));
  const proposedSet = new Set((Array.isArray(proposed && proposed.weights) ? proposed.weights : []).map((row: AnyObj) => String(row.token || '')));
  const union = new Set([...Array.from(currentSet), ...Array.from(proposedSet)]);
  if (!union.size) return 0;
  let overlap = 0;
  for (const token of currentSet) if (proposedSet.has(token)) overlap += 1;
  return Number((1 - (overlap / union.size)).toFixed(6));
}

function loadCurrentAnchor(policy: AnyObj) {
  const current = readJson(policy.current_anchor_path, null);
  if (current && typeof current === 'object' && Array.isArray(current.weights)) return current;
  return null;
}

function writeReceipt(policy: AnyObj, row: AnyObj) {
  appendJsonl(policy.receipts_path, {
    ts: nowIso(),
    policy_version: policy.schema_version,
    policy_path: rel(policy.policy_path),
    ...row
  });
}

function cmdRun(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  if (policy.enabled !== true) {
    process.stdout.write(`${JSON.stringify({ ok: false, reason: 'policy_disabled' }, null, 2)}\n`);
    process.exit(1);
  }

  const current = loadCurrentAnchor(policy);
  const proposed = deriveAnchor(policy);
  const drift = current ? driftScore(current, proposed) : 0;
  const apply = boolFlag(args.apply, false);
  const approvedBy = normalizeToken(args['approved-by'] || args.approved_by || '', 120);
  const approvalNote = cleanText(args['approval-note'] || args.approval_note || '', 260);
  const highImpact = drift >= Number(policy.high_impact_shift || 0.15);
  const requiresReview = policy.require_user_review_above_shift === true && drift >= Number(policy.max_auto_shift || 0.08);

  const proposal = {
    type: 'value_anchor_renewal_proposal',
    ts: nowIso(),
    proposal_id: `renew_${sha16(`${proposed.anchor_id}|${nowIso()}`)}`,
    previous_anchor_id: current ? current.anchor_id || null : null,
    proposed_anchor_id: proposed.anchor_id,
    drift_score: drift,
    requires_review: requiresReview,
    high_impact: highImpact,
    proposed
  };
  appendJsonl(policy.proposals_path, proposal);

  if (apply) {
    if (requiresReview && (!approvedBy || !approvalNote)) {
      process.stdout.write(`${JSON.stringify({ ok: false, reason: 'explicit_review_required', drift_score: drift }, null, 2)}\n`);
      process.exit(1);
    }
    const nextAnchor = {
      ...proposed,
      approved_by: approvedBy || null,
      approval_note: approvalNote || null,
      previous_anchor: current ? {
        anchor_id: current.anchor_id || null,
        derived_at: current.derived_at || null,
        weights: current.weights || []
      } : null
    };
    if (current) {
      appendJsonl(policy.history_path, {
        type: 'value_anchor_history',
        ts: nowIso(),
        anchor_id: current.anchor_id,
        replaced_by: proposed.anchor_id,
        drift_score: drift,
        reversible: true,
        snapshot: current
      });
    }
    writeJsonAtomic(policy.current_anchor_path, nextAnchor);
    writeReceipt(policy, {
      type: 'value_anchor_renewal_apply',
      previous_anchor_id: current ? current.anchor_id || null : null,
      anchor_id: proposed.anchor_id,
      drift_score: drift,
      requires_review: requiresReview,
      high_impact: highImpact,
      approved_by: approvedBy || null
    });
    process.stdout.write(`${JSON.stringify({
      ok: true,
      type: 'value_anchor_renewal_apply',
      anchor_id: proposed.anchor_id,
      previous_anchor_id: current ? current.anchor_id || null : null,
      drift_score: drift,
      requires_review: requiresReview,
      high_impact: highImpact
    }, null, 2)}\n`);
    return;
  }

  writeReceipt(policy, {
    type: 'value_anchor_renewal_proposed',
    previous_anchor_id: current ? current.anchor_id || null : null,
    proposed_anchor_id: proposed.anchor_id,
    drift_score: drift,
    requires_review: requiresReview,
    high_impact: highImpact
  });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'value_anchor_renewal_proposed',
    proposed_anchor_id: proposed.anchor_id,
    previous_anchor_id: current ? current.anchor_id || null : null,
    drift_score: drift,
    requires_review: requiresReview,
    high_impact: highImpact
  }, null, 2)}\n`);
}

function cmdStatus(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const current = loadCurrentAnchor(policy);
  const proposals = readJsonl(policy.proposals_path);
  const latestProposal = proposals.length ? proposals[proposals.length - 1] : null;
  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'value_anchor_renewal_status',
    ts: nowIso(),
    policy_path: rel(policy.policy_path),
    current_anchor_path: rel(policy.current_anchor_path),
    proposals_path: rel(policy.proposals_path),
    history_path: rel(policy.history_path),
    receipts_path: rel(policy.receipts_path),
    current_anchor_id: current ? current.anchor_id || null : null,
    proposal_count: proposals.length,
    latest_proposal: latestProposal ? {
      proposal_id: latestProposal.proposal_id || null,
      proposed_anchor_id: latestProposal.proposed_anchor_id || null,
      drift_score: Number(latestProposal.drift_score || 0)
    } : null
  }, null, 2)}\n`);
}

function main(argv: string[]) {
  const args = parseArgs(argv);
  const cmd = String(args._[0] || '').trim().toLowerCase();
  if (!cmd || cmd === 'help' || cmd === '--help' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'run') return cmdRun(args);
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
  deriveAnchor,
  driftScore
};
