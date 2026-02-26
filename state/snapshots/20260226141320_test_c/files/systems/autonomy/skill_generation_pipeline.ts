#!/usr/bin/env node
'use strict';

/**
 * skill_generation_pipeline.js
 *
 * Guarded autonomous skill generation pipeline:
 * pattern -> candidate skill -> sandbox gate -> necessity/ROI gate -> approval queue.
 *
 * Usage:
 *   node systems/autonomy/skill_generation_pipeline.js run [--days=14] [--max-candidates=5] [--apply=1|0]
 *   node systems/autonomy/skill_generation_pipeline.js status
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const POLICY_PATH = process.env.SKILL_GENERATION_POLICY_PATH
  ? path.resolve(process.env.SKILL_GENERATION_POLICY_PATH)
  : path.join(ROOT, 'config', 'skill_generation_policy.json');
const RUNS_DIR = process.env.SKILL_GENERATION_RUNS_DIR
  ? path.resolve(process.env.SKILL_GENERATION_RUNS_DIR)
  : path.join(ROOT, 'state', 'autonomy', 'runs');
const STATE_DIR = process.env.SKILL_GENERATION_STATE_DIR
  ? path.resolve(process.env.SKILL_GENERATION_STATE_DIR)
  : path.join(ROOT, 'state', 'autonomy', 'skill_generation');

const CANDIDATES_DIR = path.join(STATE_DIR, 'candidates');
const QUARANTINE_DIR = path.join(STATE_DIR, 'quarantine');
const APPROVAL_QUEUE_PATH = path.join(STATE_DIR, 'approval_queue.json');
const RECEIPTS_PATH = path.join(STATE_DIR, 'receipts.jsonl');

function nowIso() {
  return new Date().toISOString();
}

function todayStr() {
  return nowIso().slice(0, 10);
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/autonomy/skill_generation_pipeline.js run [--days=14] [--max-candidates=5] [--apply=1|0]');
  console.log('  node systems/autonomy/skill_generation_pipeline.js status');
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

function toBool(v, fallback = false) {
  if (v == null) return fallback;
  const s = normalizeText(v, 24).toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  return fallback;
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

function writeJsonAtomic(filePath, value) {
  ensureDir(filePath);
  const tmp = `${filePath}.tmp-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
}

function appendJsonl(filePath, row) {
  ensureDir(filePath);
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function relPath(p) {
  return path.relative(ROOT, p).replace(/\\/g, '/');
}

function shiftDate(dateStr, deltaDays) {
  const base = new Date(`${dateStr}T00:00:00.000Z`);
  if (Number.isNaN(base.getTime())) return dateStr;
  base.setUTCDate(base.getUTCDate() + Number(deltaDays || 0));
  return base.toISOString().slice(0, 10);
}

function windowDates(endDate, days) {
  const out = [];
  for (let i = days - 1; i >= 0; i -= 1) out.push(shiftDate(endDate, -i));
  return out;
}

function defaultPolicy() {
  return {
    version: '1.0',
    min_pattern_attempts: 4,
    min_pattern_shipped: 2,
    min_estimated_savings_minutes: 30,
    max_candidates_per_run: 5,
    novelty_only_block_enabled: true,
    require_dual_approval: true
  };
}

function loadPolicy(policyPath = POLICY_PATH) {
  const src = readJson(policyPath, {});
  const base = defaultPolicy();
  return {
    version: normalizeText(src.version || base.version, 32) || '1.0',
    min_pattern_attempts: clampInt(src.min_pattern_attempts, 1, 1000, base.min_pattern_attempts),
    min_pattern_shipped: clampInt(src.min_pattern_shipped, 1, 1000, base.min_pattern_shipped),
    min_estimated_savings_minutes: clampInt(src.min_estimated_savings_minutes, 1, 100000, base.min_estimated_savings_minutes),
    max_candidates_per_run: clampInt(src.max_candidates_per_run, 1, 100, base.max_candidates_per_run),
    novelty_only_block_enabled: src.novelty_only_block_enabled !== false,
    require_dual_approval: src.require_dual_approval !== false
  };
}

function loadApprovalQueue() {
  const src = readJson(APPROVAL_QUEUE_PATH, null);
  if (!src || typeof src !== 'object') {
    return {
      schema_id: 'skill_generation_approval_queue',
      schema_version: '1.0',
      pending: [],
      approved: [],
      denied: []
    };
  }
  return {
    schema_id: 'skill_generation_approval_queue',
    schema_version: '1.0',
    pending: Array.isArray(src.pending) ? src.pending : [],
    approved: Array.isArray(src.approved) ? src.approved : [],
    denied: Array.isArray(src.denied) ? src.denied : []
  };
}

function saveApprovalQueue(queue) {
  writeJsonAtomic(APPROVAL_QUEUE_PATH, queue);
}

function listRuns(dateStr, days) {
  const out = [];
  for (const day of windowDates(dateStr, days)) {
    const fp = path.join(RUNS_DIR, `${day}.jsonl`);
    for (const row of readJsonl(fp)) {
      if (!row || row.type !== 'autonomy_run') continue;
      out.push(row);
    }
  }
  return out;
}

function patternKey(row) {
  const parts = [
    normalizeToken(row.proposal_type || 'unknown', 64) || 'unknown',
    normalizeToken(row.source_eye || 'unknown_eye', 64) || 'unknown_eye',
    normalizeToken(row.capability_key || '', 80) || 'none'
  ];
  return parts.join('|');
}

function estimateSavingsMinutes(stats) {
  return (Number(stats.shipped || 0) * 20)
    + (Number(stats.no_change || 0) * 5)
    + (Number(stats.reverted || 0) * 3);
}

function summarizePatterns(rows) {
  const byKey = new Map();
  for (const row of rows) {
    const key = patternKey(row);
    const cur = byKey.get(key) || {
      key,
      proposal_type: normalizeToken(row.proposal_type || 'unknown', 80) || 'unknown',
      source_eye: normalizeToken(row.source_eye || 'unknown_eye', 80) || 'unknown_eye',
      capability_key: normalizeToken(row.capability_key || '', 120) || null,
      attempted: 0,
      shipped: 0,
      no_change: 0,
      reverted: 0
    };
    cur.attempted += 1;
    const outcome = normalizeToken(row.outcome || row.result || 'unknown', 32);
    if (outcome === 'shipped') cur.shipped += 1;
    else if (outcome === 'no_change') cur.no_change += 1;
    else if (outcome === 'reverted') cur.reverted += 1;
    byKey.set(key, cur);
  }

  const out = [];
  for (const stats of byKey.values()) {
    const estimatedSavingsMinutes = estimateSavingsMinutes(stats);
    out.push({
      ...stats,
      estimated_savings_minutes: estimatedSavingsMinutes
    });
  }
  out.sort((a, b) => {
    if (b.shipped !== a.shipped) return b.shipped - a.shipped;
    if (b.estimated_savings_minutes !== a.estimated_savings_minutes) return b.estimated_savings_minutes - a.estimated_savings_minutes;
    return String(a.key).localeCompare(String(b.key));
  });
  return out;
}

function skillIdFromPattern(pattern) {
  const digest = crypto.createHash('sha256').update(`${pattern.key}|${pattern.shipped}|${pattern.attempted}`).digest('hex');
  return `skill_${digest.slice(0, 12)}`;
}

function sandboxGate(pattern, policy) {
  const reasons = [];
  if (pattern.attempted < policy.min_pattern_attempts) reasons.push('pattern_attempts_below_min');
  if (pattern.shipped < policy.min_pattern_shipped) reasons.push('pattern_shipped_below_min');
  if (pattern.estimated_savings_minutes < policy.min_estimated_savings_minutes) reasons.push('estimated_savings_below_min');
  if (policy.novelty_only_block_enabled && pattern.shipped <= 0) reasons.push('novelty_only_pattern_blocked');
  return {
    pass: reasons.length === 0,
    reasons
  };
}

function buildCandidate(pattern, policy) {
  const skillId = skillIdFromPattern(pattern);
  const candidate = {
    schema_id: 'skill_generation_candidate',
    schema_version: '1.0',
    skill_id: skillId,
    created_at: nowIso(),
    pattern: {
      key: pattern.key,
      proposal_type: pattern.proposal_type,
      source_eye: pattern.source_eye,
      capability_key: pattern.capability_key,
      attempted: pattern.attempted,
      shipped: pattern.shipped,
      no_change: pattern.no_change,
      reverted: pattern.reverted,
      estimated_savings_minutes: pattern.estimated_savings_minutes
    },
    generated_skill_stub: {
      name: `${pattern.proposal_type}_${pattern.source_eye}_skill`,
      trigger: {
        proposal_type: pattern.proposal_type,
        source_eye: pattern.source_eye
      },
      action: {
        mode: 'bounded_execution',
        notes: 'Generated candidate from repeated successful pattern'
      }
    },
    approval_requirements: {
      dual_approval_required: policy.require_dual_approval,
      reason: 'autonomous_skill_generation'
    }
  };

  const gate = sandboxGate(pattern, policy);
  return {
    candidate,
    gate
  };
}

function queueApproval(candidate, policy) {
  const queue = loadApprovalQueue();
  const actionId = `approve_${candidate.skill_id}`;
  const exists = queue.pending.some((row) => row && row.action_id === actionId);
  if (!exists) {
    queue.pending.push({
      action_id: actionId,
      ts: nowIso(),
      type: 'skill_generation_promotion',
      skill_id: candidate.skill_id,
      summary: `Promote generated skill candidate ${candidate.skill_id}`,
      dual_approval_required: policy.require_dual_approval === true,
      status: 'PENDING'
    });
    saveApprovalQueue(queue);
  }
  return {
    queued: !exists,
    action_id: actionId
  };
}

function cmdRun(args) {
  const policy = loadPolicy();
  const dateStr = normalizeText(args.date || args._[1] || todayStr(), 10) || todayStr();
  const days = clampInt(args.days, 1, 90, 14);
  const apply = toBool(args.apply, true);
  const maxCandidates = clampInt(args['max-candidates'] || args.max_candidates, 1, 100, policy.max_candidates_per_run);

  const patterns = summarizePatterns(listRuns(dateStr, days));
  const selected = patterns.slice(0, maxCandidates);
  const generated = [];
  const rejected = [];

  for (const pattern of selected) {
    const built = buildCandidate(pattern, policy);
    if (!built.gate.pass) {
      rejected.push({
        pattern: pattern.key,
        reasons: built.gate.reasons
      });
      continue;
    }

    const skillId = built.candidate.skill_id;
    const candidatePath = path.join(CANDIDATES_DIR, `${skillId}.json`);
    const quarantinePath = path.join(QUARANTINE_DIR, `${skillId}.json`);

    if (apply) {
      writeJsonAtomic(quarantinePath, {
        ...built.candidate,
        state: 'quarantine'
      });
      writeJsonAtomic(candidatePath, {
        ...built.candidate,
        state: 'candidate'
      });
    }

    const approval = apply ? queueApproval(built.candidate, policy) : { queued: false, action_id: null };
    generated.push({
      skill_id: skillId,
      pattern: pattern.key,
      candidate_path: apply ? relPath(candidatePath) : null,
      quarantine_path: apply ? relPath(quarantinePath) : null,
      approval
    });
  }

  const out = {
    ok: true,
    type: 'skill_generation_pipeline_run',
    ts: nowIso(),
    policy_version: policy.version,
    window: {
      end_date: dateStr,
      days
    },
    apply,
    analyzed_patterns: patterns.length,
    generated_count: generated.length,
    rejected_count: rejected.length,
    generated,
    rejected
  };

  if (apply) {
    appendJsonl(RECEIPTS_PATH, out);
  }
  process.stdout.write(JSON.stringify(out) + '\n');
}

function cmdStatus() {
  const rows = readJsonl(RECEIPTS_PATH)
    .filter((row) => row && row.type === 'skill_generation_pipeline_run')
    .slice(-30);
  const approvals = loadApprovalQueue();
  process.stdout.write(JSON.stringify({
    ok: true,
    type: 'skill_generation_pipeline_status',
    ts: nowIso(),
    receipts_path: relPath(RECEIPTS_PATH),
    recent_runs: rows.length,
    pending_approvals: approvals.pending.length,
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
  if (cmd === 'run') return cmdRun(args);
  if (cmd === 'status') return cmdStatus();
  usage();
  process.exit(2);
}

if (require.main === module) {
  main();
}

module.exports = {
  loadPolicy,
  summarizePatterns,
  sandboxGate
};
export {};
