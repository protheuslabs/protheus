#!/usr/bin/env node
'use strict';

/**
 * systems/autonomy/adaptive_crystallizer.js
 *
 * Deterministic bridge:
 *   adaptive habits/reflexes -> proposal candidates for system primitives.
 *
 * Safety:
 * - Proposal-only. Never mutates system source files.
 * - Requires recurring usage + high generality signal.
 * - Cooldown + rearm prevent queue spam.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { readHabitState } = require('../adaptive/habits/habit_store');
const { readReflexState } = require('../adaptive/reflex/reflex_store');

const ROOT = path.resolve(__dirname, '..', '..');
const LEGACY_HABITS_PATH = path.join(ROOT, 'habits', 'registry.json');
const REFLEX_RUNTIME_ROUTINES_PATH = path.join(ROOT, 'state', 'adaptive', 'reflex', 'routines.json');
const REFLEX_EVENTS_PATH = path.join(ROOT, 'state', 'adaptive', 'reflex', 'events.jsonl');

const STATE_PATH = process.env.ADAPTIVE_CRYSTALLIZER_STATE_PATH
  ? path.resolve(String(process.env.ADAPTIVE_CRYSTALLIZER_STATE_PATH))
  : path.join(ROOT, 'state', 'autonomy', 'adaptive_crystallizer_state.json');
const LOG_PATH = process.env.ADAPTIVE_CRYSTALLIZER_LOG_PATH
  ? path.resolve(String(process.env.ADAPTIVE_CRYSTALLIZER_LOG_PATH))
  : path.join(ROOT, 'state', 'autonomy', 'adaptive_crystallizer.jsonl');
const PROPOSALS_DIR = process.env.ADAPTIVE_CRYSTALLIZER_PROPOSALS_DIR
  ? path.resolve(String(process.env.ADAPTIVE_CRYSTALLIZER_PROPOSALS_DIR))
  : path.join(ROOT, 'state', 'sensory', 'proposals');

const VERSION = '1.0';

function nowIso() {
  return new Date().toISOString();
}

function todayStr(v = null) {
  const d = v ? new Date(String(v)) : new Date();
  if (Number.isNaN(d.getTime())) return new Date().toISOString().slice(0, 10);
  return d.toISOString().slice(0, 10);
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function readJsonlSafe(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

function writeJson(filePath, obj) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function appendJsonl(filePath, row) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, JSON.stringify(row) + '\n', 'utf8');
}

function clean(v, maxLen = 180) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeKey(v, maxLen = 90) {
  return String(v || '')
    .toLowerCase()
    .replace(/[^a-z0-9:_-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, maxLen);
}

function clamp(v, lo, hi) {
  const n = Number(v);
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

function parseIsoMs(v) {
  const ms = Date.parse(String(v || ''));
  return Number.isFinite(ms) ? ms : null;
}

function bumpCount(map, key) {
  if (!map || typeof map !== 'object') return;
  const k = String(key || 'unknown');
  map[k] = Number(map[k] || 0) + 1;
}

function sha16(v) {
  return crypto.createHash('sha256').update(String(v || '')).digest('hex').slice(0, 16);
}

function loadConfig() {
  return {
    habit_min_uses_30d: Math.max(1, Number(process.env.ADAPTIVE_CRYSTAL_HABIT_MIN_USES_30D || 4)),
    habit_min_lifetime_uses: Math.max(1, Number(process.env.ADAPTIVE_CRYSTAL_HABIT_MIN_LIFETIME || 10)),
    habit_min_success_rate: clamp(Number(process.env.ADAPTIVE_CRYSTAL_HABIT_MIN_SUCCESS || 0.75), 0, 1),
    reflex_min_runs_14d: Math.max(1, Number(process.env.ADAPTIVE_CRYSTAL_REFLEX_MIN_RUNS_14D || 8)),
    reflex_min_runs_3d: Math.max(1, Number(process.env.ADAPTIVE_CRYSTAL_REFLEX_MIN_RUNS_3D || 2)),
    min_generality_score: clamp(Number(process.env.ADAPTIVE_CRYSTAL_MIN_GENERALITY || 62), 1, 100),
    min_total_score: clamp(Number(process.env.ADAPTIVE_CRYSTAL_MIN_SCORE || 70), 1, 100),
    cooldown_hours: Math.max(1, Number(process.env.ADAPTIVE_CRYSTAL_COOLDOWN_HOURS || 24)),
    rearm_delta_score: clamp(Number(process.env.ADAPTIVE_CRYSTAL_REARM_DELTA_SCORE || 8), 1, 40),
    max_proposals_per_run: Math.max(1, Number(process.env.ADAPTIVE_CRYSTAL_MAX_PER_RUN || 4)),
    dynamic_relax_step: clamp(Number(process.env.ADAPTIVE_CRYSTAL_DYNAMIC_RELAX_STEP || 4), 0, 12, 4),
    rejected_sample_limit: Math.max(1, Number(process.env.ADAPTIVE_CRYSTAL_REJECTED_SAMPLE_LIMIT || 8))
  };
}

function loadState() {
  const raw = readJsonSafe(STATE_PATH, null);
  if (!raw || typeof raw !== 'object') {
    return { version: VERSION, updated_ts: null, entries: {} };
  }
  return {
    version: VERSION,
    updated_ts: raw.updated_ts ? String(raw.updated_ts) : null,
    entries: raw.entries && typeof raw.entries === 'object' ? raw.entries : {}
  };
}

function saveState(state) {
  writeJson(STATE_PATH, {
    version: VERSION,
    updated_ts: nowIso(),
    entries: state && state.entries && typeof state.entries === 'object' ? state.entries : {}
  });
}

function loadProposalFile(dateStr) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || '')) ? String(dateStr) : todayStr();
  const filePath = path.join(PROPOSALS_DIR, `${date}.json`);
  const rows = readJsonSafe(filePath, []);
  return {
    date,
    filePath,
    proposals: Array.isArray(rows) ? rows : []
  };
}

function saveProposalFile(filePath, proposals) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(Array.isArray(proposals) ? proposals : [], null, 2) + '\n', 'utf8');
}

function addProposalIfMissing(dateStr, proposal) {
  const ctx = loadProposalFile(dateStr);
  const proposalId = String(proposal && proposal.id || '');
  const idx = ctx.proposals.findIndex((p) => p && String(p.id || '') === proposalId);
  if (idx >= 0) {
    const prev = ctx.proposals[idx];
    if (JSON.stringify(prev) === JSON.stringify(proposal)) {
      return { added: false, updated: false, proposal_id: proposalId };
    }
    ctx.proposals[idx] = proposal;
    saveProposalFile(ctx.filePath, ctx.proposals);
    return { added: false, updated: true, proposal_id: proposalId };
  }
  ctx.proposals.push(proposal);
  saveProposalFile(ctx.filePath, ctx.proposals);
  return { added: true, updated: false, proposal_id: proposalId };
}

function loadLegacyHabitRows() {
  const raw = readJsonSafe(LEGACY_HABITS_PATH, {});
  const rows = Array.isArray(raw && raw.habits) ? raw.habits : [];
  return rows.map((row) => ({
    id: normalizeKey(row && row.id || '', 90),
    name: clean(row && row.name || row && row.id || '', 140),
    summary: clean(row && row.description || '', 240),
    status: String(row && row.status || row && row.governance && row.governance.state || 'candidate').toLowerCase(),
    uses_30d: Number(row && row.uses_30d || 0),
    lifetime_uses: Number(row && row.lifetime_uses || 0),
    success_rate: Number(row && row.success_rate || 0),
    last_used_ts: row && row.last_used_at ? String(row.last_used_at) : null,
    source: 'legacy'
  })).filter((x) => x.id);
}

function loadAdaptiveHabitRows() {
  const state = readHabitState(null, null);
  const rows = Array.isArray(state && state.routines) ? state.routines : [];
  return rows.map((row) => ({
    id: normalizeKey(row && row.id || '', 90),
    name: clean(row && row.name || row && row.id || '', 140),
    summary: clean(row && row.summary || '', 240),
    status: String(row && row.status || 'candidate').toLowerCase(),
    uses_30d: Number(row && row.usage && row.usage.uses_30d || 0),
    lifetime_uses: Number(row && row.usage && row.usage.uses_total || 0),
    success_rate: null,
    last_used_ts: row && row.usage && row.usage.last_used_ts ? String(row.usage.last_used_ts) : null,
    source: 'adaptive'
  })).filter((x) => x.id);
}

function mergeHabitRows() {
  const merged = new Map();
  for (const row of [...loadAdaptiveHabitRows(), ...loadLegacyHabitRows()]) {
    const id = String(row.id || '');
    if (!id) continue;
    const prev = merged.get(id);
    if (!prev) {
      merged.set(id, row);
      continue;
    }
    merged.set(id, {
      ...prev,
      uses_30d: Math.max(Number(prev.uses_30d || 0), Number(row.uses_30d || 0)),
      lifetime_uses: Math.max(Number(prev.lifetime_uses || 0), Number(row.lifetime_uses || 0)),
      success_rate: Number.isFinite(Number(prev.success_rate)) && Number(prev.success_rate) > 0
        ? Number(prev.success_rate)
        : Number(row.success_rate),
      last_used_ts: prev.last_used_ts || row.last_used_ts,
      source: prev.source === 'adaptive' || row.source !== 'adaptive' ? prev.source : row.source
    });
  }
  return Array.from(merged.values());
}

function loadRuntimeReflexRows() {
  const raw = readJsonSafe(REFLEX_RUNTIME_ROUTINES_PATH, {});
  const rows = raw && typeof raw === 'object' ? Object.values(raw) : [];
  return Array.isArray(rows) ? rows : [];
}

function loadAdaptiveReflexRows() {
  const state = readReflexState(null, null);
  const rows = Array.isArray(state && state.routines) ? state.routines : [];
  return rows.map((row) => ({
    id: normalizeKey(row && (row.key || row.id) || '', 90),
    name: clean(row && row.name || row && (row.key || row.id) || '', 140),
    status: String(row && row.status || 'disabled').toLowerCase(),
    last_run_ts: row && row.last_run_ts ? String(row.last_run_ts) : null,
    source: 'adaptive'
  })).filter((x) => x.id);
}

function mergeReflexRows() {
  const out = new Map();
  for (const row of loadRuntimeReflexRows()) {
    const id = normalizeKey(row && row.id || '', 90);
    if (!id) continue;
    out.set(id, {
      id,
      name: clean(row && row.description || row && row.id || '', 140),
      status: String(row && row.status || 'enabled').toLowerCase(),
      last_run_ts: row && row.last_run_ts ? String(row.last_run_ts) : null,
      source: 'runtime'
    });
  }
  for (const row of loadAdaptiveReflexRows()) {
    if (!out.has(row.id)) out.set(row.id, row);
  }
  return Array.from(out.values());
}

function reflexRunCounts() {
  const rows = readJsonlSafe(REFLEX_EVENTS_PATH);
  const nowMs = Date.now();
  const out = {};
  for (const row of rows) {
    if (!row || String(row.type || '') !== 'reflex_routine_run') continue;
    const rid = normalizeKey(row && row.routine_id || row && row.id || '', 90);
    if (!rid) continue;
    if (!out[rid]) out[rid] = { runs_14d: 0, runs_3d: 0, last_run_ts: null };
    const ts = String(row.ts || '');
    const ms = parseIsoMs(ts);
    if (Number.isFinite(ms)) {
      if ((nowMs - ms) <= 14 * 24 * 60 * 60 * 1000) out[rid].runs_14d += 1;
      if ((nowMs - ms) <= 3 * 24 * 60 * 60 * 1000) out[rid].runs_3d += 1;
      if (!out[rid].last_run_ts || parseIsoMs(out[rid].last_run_ts) < ms) out[rid].last_run_ts = ts;
    }
  }
  return out;
}

function generalityScore(text) {
  const src = String(text || '').toLowerCase();
  let score = 70;
  const genericTokens = [
    'deterministic', 'generic', 'general', 'reusable', 'bounded', 'retry', 'timeout',
    'fallback', 'validation', 'rollback', 'queue', 'state', 'health', 'guard',
    'memory', 'routing', 'signal', 'error', 'recovery', 'budget'
  ];
  const seen = new Set();
  for (const t of genericTokens) {
    if (src.includes(t) && !seen.has(t)) {
      seen.add(t);
      score += 4;
    }
  }
  if (/https?:\/\//.test(src)) score -= 20;
  if (/@[a-z0-9_]/.test(src)) score -= 12;
  if (/\b(eye-|prp-|csg-|hyp-|pain-)\w+/i.test(src)) score -= 25;
  if (/\b[a-f0-9]{16,}\b/.test(src)) score -= 10;
  const hasConcreteDomain = /\b[a-z0-9-]+\.(com|net|org|io|ai|dev)\b/.test(src);
  const hasServiceCoupling = /\b(api|rss|feed|webhook|endpoint|oauth)\b/.test(src);
  const hasCommsSurface = /\b(post|comment|message|inbox|chat|email|profile)\b/.test(src);
  if (hasConcreteDomain) score -= 12;
  if (hasServiceCoupling) score -= 10;
  if (hasCommsSurface) score -= 8;
  return clamp(Math.round(score), 1, 100);
}

function scoreHabit(row) {
  const uses30 = Math.max(0, Number(row.uses_30d || 0));
  const life = Math.max(0, Number(row.lifetime_uses || 0));
  const success = Number(row.success_rate);
  const successNorm = Number.isFinite(success) ? clamp(success * 100, 1, 100) : 60;
  const usageScore = clamp((uses30 * 8) + (life * 1.2), 1, 100);
  const genScore = generalityScore(`${row.id} ${row.name} ${row.summary}`);
  const total = clamp(Math.round((usageScore * 0.45) + (genScore * 0.35) + (successNorm * 0.20)), 1, 100);
  return {
    usage_score: usageScore,
    generality_score: genScore,
    stability_score: successNorm,
    total_score: total
  };
}

function scoreReflex(row, runs) {
  const r14 = Math.max(0, Number(runs && runs.runs_14d || 0));
  const r3 = Math.max(0, Number(runs && runs.runs_3d || 0));
  const usageScore = clamp((r14 * 7) + (r3 * 8), 1, 100);
  const genScore = generalityScore(`${row.id} ${row.name}`);
  const stabilityScore = clamp(55 + Math.min(45, r3 * 9), 1, 100);
  const total = clamp(Math.round((usageScore * 0.50) + (genScore * 0.35) + (stabilityScore * 0.15)), 1, 100);
  return {
    usage_score: usageScore,
    generality_score: genScore,
    stability_score: stabilityScore,
    total_score: total
  };
}

function shouldEmit(key, score, state, cfg) {
  const prev = state.entries && state.entries[key] && typeof state.entries[key] === 'object'
    ? state.entries[key]
    : {};
  const nowMs = Date.now();
  const cooldownUntilMs = parseIsoMs(prev.cooldown_until_ts);
  if (Number.isFinite(cooldownUntilMs) && cooldownUntilMs > nowMs) {
    return { ok: false, reason: 'cooldown_active' };
  }
  const lastScore = Number(prev.last_total_score || 0);
  if (lastScore > 0 && score < (lastScore + Number(cfg.rearm_delta_score || 0))) {
    return { ok: false, reason: 'rearm_delta_not_met' };
  }
  return { ok: true, reason: 'ready' };
}

function buildProposal(dateStr, candidate) {
  const layer = String(candidate.layer || 'habit');
  const id = String(candidate.id || '').slice(0, 90);
  const key = `${layer}:${id}`;
  const proposalId = `ACRY-${sha16(key)}`;
  const targetFile = layer === 'habit'
    ? 'systems/adaptive/habits/habit_runtime_sync.js'
    : 'systems/adaptive/reflex/reflex_runtime_sync.js';
  const task = (
    `Extract a reusable system primitive from adaptive ${layer} pattern ${id}. ` +
    `Implement changes in ${targetFile} and preserve existing behavior with rollback and verification plan. ` +
    `Do not encode source-specific logic.`
  ).replace(/"/g, '\\"');
  return {
    id: proposalId,
    type: 'adaptive_crystallization_candidate',
    title: `[Crystallize] ${layer}:${id}`.slice(0, 120),
    summary: `Adaptive ${layer} pattern qualifies for promotion review into a generic system primitive.`,
    expected_impact: 'medium',
    risk: 'low',
    validation: [
      'postconditions pass on next run',
      'outcome receipt logged on next run',
      'at least 1 artifact produced within 24h',
      'resulting primitive is generic and reusable (no source-specific hardcoding)',
      'rollback path is explicitly defined and verified in dry-run'
    ],
    suggested_next_command: `node systems/routing/route_execute.js --task="${task}" --tokens_est=900 --repeats_14d=2 --errors_30d=1 --dry-run`,
    action_spec: {
      objective: `Extract and implement a reusable ${layer} primitive from adaptive pattern ${id}.`,
      target: targetFile,
      next_command: `node systems/routing/route_execute.js --task="${task}" --tokens_est=900 --repeats_14d=2 --errors_30d=1 --dry-run`,
      rollback: 'Revert touched primitive/sync files and keep adaptive routines as source of truth.',
      verify: [
        'postconditions pass on next run',
        'outcome receipt logged on next run',
        'execution success in next run'
      ],
      success_criteria: [
        { metric: 'artifact_count', target: '>=1 artifact', horizon: '24h' },
        { metric: 'queue_outcome_logged', target: 'outcome receipt logged', horizon: 'next run' },
        { metric: 'postconditions_ok', target: 'postconditions pass', horizon: 'next run' }
      ]
    },
    evidence: [
      {
        source: `adaptive_${layer}`,
        path: layer === 'habit' ? 'habits/registry.json' : 'state/adaptive/reflex/events.jsonl',
        match: `${layer}:${id}`.slice(0, 120),
        evidence_ref: `adaptive_crystallizer:${key}`
      }
    ],
    meta: {
      source_eye: 'adaptive_crystallizer',
      layer,
      adaptive_id: id,
      adaptive_key: key,
      adaptive_source: candidate.source || null,
      total_score: Number(candidate.score && candidate.score.total_score || 0),
      usage_score: Number(candidate.score && candidate.score.usage_score || 0),
      generality_score: Number(candidate.score && candidate.score.generality_score || 0),
      stability_score: Number(candidate.score && candidate.score.stability_score || 0),
      generated_at: nowIso()
    }
  };
}

function evaluateHabitCandidates(cfg, opts = {}) {
  const includeRejected = opts && opts.includeRejected === true;
  const rows = mergeHabitRows();
  const out = [];
  const rejected = [];
  for (const row of rows) {
    const reasons = [];
    const status = String(row.status || '').toLowerCase();
    if (status !== 'active') reasons.push('status_not_active');
    const uses30 = Number(row.uses_30d || 0);
    const life = Number(row.lifetime_uses || 0);
    const success = Number(row.success_rate);
    if (uses30 < cfg.habit_min_uses_30d) reasons.push('habit_uses_30d_low');
    if (life < cfg.habit_min_lifetime_uses) reasons.push('habit_lifetime_low');
    if (Number.isFinite(success) && success < cfg.habit_min_success_rate) reasons.push('habit_success_rate_low');
    const score = scoreHabit(row);
    if (score.generality_score < cfg.min_generality_score) reasons.push('generality_low');
    if (score.total_score < cfg.min_total_score) reasons.push('total_score_low');
    const cand = {
      layer: 'habit',
      id: row.id,
      name: row.name,
      summary: row.summary,
      source: row.source,
      score,
      stats: {
        uses_30d: uses30,
        lifetime_uses: life,
        success_rate: Number.isFinite(success) ? success : null,
        last_used_ts: row.last_used_ts || null
      }
    };
    if (reasons.length === 0) out.push(cand);
    else if (includeRejected) rejected.push({ ...cand, reasons });
  }
  if (includeRejected) return { eligible: out, rejected };
  return out;
}

function evaluateReflexCandidates(cfg, opts = {}) {
  const includeRejected = opts && opts.includeRejected === true;
  const rows = mergeReflexRows();
  const counts = reflexRunCounts();
  const out = [];
  const rejected = [];
  for (const row of rows) {
    const reasons = [];
    const status = String(row.status || '').toLowerCase();
    if (!(status === 'enabled' || status === 'active')) reasons.push('status_not_enabled');
    const runs = counts[row.id] || { runs_14d: 0, runs_3d: 0, last_run_ts: null };
    if (Number(runs.runs_14d || 0) < cfg.reflex_min_runs_14d) reasons.push('reflex_runs_14d_low');
    if (Number(runs.runs_3d || 0) < cfg.reflex_min_runs_3d) reasons.push('reflex_runs_3d_low');
    const score = scoreReflex(row, runs);
    if (score.generality_score < cfg.min_generality_score) reasons.push('generality_low');
    if (score.total_score < cfg.min_total_score) reasons.push('total_score_low');
    const cand = {
      layer: 'reflex',
      id: row.id,
      name: row.name,
      summary: clean(row.name || row.id, 240),
      source: row.source,
      score,
      stats: {
        runs_14d: Number(runs.runs_14d || 0),
        runs_3d: Number(runs.runs_3d || 0),
        last_run_ts: runs.last_run_ts || row.last_run_ts || null
      }
    };
    if (reasons.length === 0) out.push(cand);
    else if (includeRejected) rejected.push({ ...cand, reasons });
  }
  if (includeRejected) return { eligible: out, rejected };
  return out;
}

function buildCalibrationHint(cfg, rejectedByReason) {
  const counts = rejectedByReason && typeof rejectedByReason === 'object' ? rejectedByReason : {};
  const top = Object.entries(counts).sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0))[0] || null;
  if (!top) return null;
  const reason = String(top[0] || '');
  const step = Math.max(0, Number(cfg.dynamic_relax_step || 0));
  if (step <= 0) return null;
  const hint = {
    reason,
    count: Number(top[1] || 0),
    suggested_overrides: {}
  };
  if (reason === 'generality_low') {
    hint.suggested_overrides.min_generality_score = Math.max(30, Number(cfg.min_generality_score || 0) - step);
  } else if (reason === 'total_score_low') {
    hint.suggested_overrides.min_total_score = Math.max(35, Number(cfg.min_total_score || 0) - step);
  } else if (reason === 'habit_uses_30d_low') {
    hint.suggested_overrides.habit_min_uses_30d = Math.max(1, Number(cfg.habit_min_uses_30d || 0) - 1);
  } else if (reason === 'habit_lifetime_low') {
    hint.suggested_overrides.habit_min_lifetime_uses = Math.max(1, Number(cfg.habit_min_lifetime_uses || 0) - 2);
  } else if (reason === 'reflex_runs_14d_low') {
    hint.suggested_overrides.reflex_min_runs_14d = Math.max(1, Number(cfg.reflex_min_runs_14d || 0) - 1);
  } else if (reason === 'reflex_runs_3d_low') {
    hint.suggested_overrides.reflex_min_runs_3d = Math.max(1, Number(cfg.reflex_min_runs_3d || 0) - 1);
  }
  if (Object.keys(hint.suggested_overrides).length === 0) return null;
  return hint;
}

function conflictSignature(cand) {
  const id = normalizeKey(cand && cand.id || '', 96);
  const idBase = id
    .replace(/^(habit|reflex)[:_-]+/, '')
    .replace(/[_-]+(habit|reflex)$/g, '')
    .replace(/[_-]+(runtime|routine|script)$/g, '')
    .slice(0, 80);
  const name = normalizeKey(cand && cand.name || '', 120)
    .replace(/^(habit|reflex)[:_-]+/, '')
    .replace(/[_-]+(habit|reflex)$/g, '');
  const summary = normalizeKey(cand && cand.summary || '', 140)
    .replace(/(^|_)(habit|reflex|routine|script|adaptive|runtime)(_|$)/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120);
  return normalizeKey(`${idBase}|${name}|${summary}`, 180);
}

function buildCrossLayerConflictMap(candidates) {
  const groups = new Map();
  for (const cand of candidates || []) {
    const sig = conflictSignature(cand);
    if (!sig) continue;
    if (!groups.has(sig)) groups.set(sig, []);
    groups.get(sig).push(cand);
  }

  const byKey = {};
  const signatures = [];
  for (const [sig, rows] of groups.entries()) {
    if (!Array.isArray(rows) || rows.length < 2) continue;
    const layers = Array.from(new Set(rows.map((r) => String(r && r.layer || '').trim()).filter(Boolean)));
    if (layers.length < 2) continue;
    signatures.push(sig);
    const keys = rows.map((r) => `${String(r && r.layer || '')}:${String(r && r.id || '')}`);
    for (const row of rows) {
      const key = `${String(row && row.layer || '')}:${String(row && row.id || '')}`;
      byKey[key] = {
        signature: sig,
        layers,
        keys
      };
    }
  }
  return {
    by_key: byKey,
    signatures
  };
}

function run(dateStr) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || '')) ? String(dateStr) : todayStr();
  const cfg = loadConfig();
  const state = loadState();
  if (!state.entries || typeof state.entries !== 'object') state.entries = {};

  const habitEval = evaluateHabitCandidates(cfg, { includeRejected: true });
  const reflexEval = evaluateReflexCandidates(cfg, { includeRejected: true });
  const candidates = [
    ...(habitEval.eligible || []),
    ...(reflexEval.eligible || [])
  ].sort((a, b) => Number(b.score.total_score || 0) - Number(a.score.total_score || 0));
  const rejectedCandidates = [
    ...(habitEval.rejected || []),
    ...(reflexEval.rejected || [])
  ];
  const conflicts = buildCrossLayerConflictMap(candidates);
  const rejectedByReason = {};
  for (const cand of rejectedCandidates) {
    for (const reason of (cand.reasons || [])) bumpCount(rejectedByReason, reason);
  }

  const out = {
    ok: true,
    type: 'adaptive_crystallizer_run',
    date,
    config: cfg,
    eligible_habit: Number((habitEval.eligible || []).length),
    eligible_reflex: Number((reflexEval.eligible || []).length),
    considered: candidates.length,
    rejected: rejectedCandidates.length,
    rejected_by_reason: rejectedByReason,
    rejected_samples: rejectedCandidates
      .slice(0, cfg.rejected_sample_limit)
      .map((cand) => ({
        key: `${cand.layer}:${cand.id}`,
        layer: cand.layer,
        score: Number(cand.score && cand.score.total_score || 0),
        reasons: Array.isArray(cand.reasons) ? cand.reasons.slice(0, 4) : []
      })),
    emitted: 0,
    emitted_habit: 0,
    emitted_reflex: 0,
    skipped: 0,
    conflicts_detected: Number(conflicts.signatures.length || 0),
    conflict_signatures: Array.isArray(conflicts.signatures) ? conflicts.signatures.slice(0, 12) : [],
    details: []
  };

  for (const cand of candidates) {
    if (out.emitted >= cfg.max_proposals_per_run) break;
    const key = `${cand.layer}:${cand.id}`;
    const conflict = conflicts.by_key && conflicts.by_key[key] ? conflicts.by_key[key] : null;
    if (conflict) {
      out.skipped += 1;
      bumpCount(rejectedByReason, 'cross_layer_conflict');
      out.details.push({
        key,
        layer: cand.layer,
        emitted: false,
        reason: 'cross_layer_conflict',
        score: cand.score.total_score,
        conflict_signature: conflict.signature,
        conflict_layers: conflict.layers
      });
      continue;
    }
    const gate = shouldEmit(key, Number(cand.score.total_score || 0), state, cfg);
    if (!gate.ok) {
      out.skipped += 1;
      bumpCount(rejectedByReason, gate.reason);
      out.details.push({ key, layer: cand.layer, emitted: false, reason: gate.reason, score: cand.score.total_score });
      continue;
    }
    const proposal = buildProposal(date, cand);
    const add = addProposalIfMissing(date, proposal);
    const cooldownUntil = new Date(Date.now() + (cfg.cooldown_hours * 60 * 60 * 1000)).toISOString();
    state.entries[key] = {
      layer: cand.layer,
      adaptive_id: cand.id,
      last_emit_ts: nowIso(),
      cooldown_until_ts: cooldownUntil,
      last_total_score: Number(cand.score.total_score || 0),
      last_generality_score: Number(cand.score.generality_score || 0),
      last_usage_score: Number(cand.score.usage_score || 0),
      last_proposal_id: proposal.id
    };
    appendJsonl(LOG_PATH, {
      ts: nowIso(),
      type: 'adaptive_crystallization_candidate',
      date,
      key,
      layer: cand.layer,
      adaptive_id: cand.id,
      score: cand.score,
      stats: cand.stats,
      proposal_id: proposal.id,
      proposal_added: add.added === true,
      proposal_updated: add.updated === true
    });
    out.emitted += 1;
    if (cand.layer === 'habit') out.emitted_habit += 1;
    if (cand.layer === 'reflex') out.emitted_reflex += 1;
    out.details.push({
      key,
      layer: cand.layer,
      emitted: true,
      proposal_id: proposal.id,
      proposal_added: add.added === true,
      proposal_updated: add.updated === true,
      score: cand.score.total_score
    });
  }

  out.rejected_by_reason = rejectedByReason;
  if (out.emitted === 0) {
    out.calibration_hint = buildCalibrationHint(cfg, rejectedByReason);
  }

  saveState(state);
  appendJsonl(LOG_PATH, {
    ts: nowIso(),
    type: 'adaptive_crystallizer_run',
    date,
    eligible_habit: out.eligible_habit,
    eligible_reflex: out.eligible_reflex,
    considered: out.considered,
    rejected: out.rejected,
    rejected_by_reason: out.rejected_by_reason,
    emitted: out.emitted,
    emitted_habit: out.emitted_habit,
    emitted_reflex: out.emitted_reflex,
    skipped: out.skipped,
    conflicts_detected: out.conflicts_detected,
    calibration_hint: out.calibration_hint || null
  });

  return out;
}

function status() {
  const state = loadState();
  const entries = Object.values(state.entries || {});
  const active = entries.filter((row) => {
    const ms = parseIsoMs(row && row.cooldown_until_ts);
    return Number.isFinite(ms) && ms > Date.now();
  }).length;
  return {
    ok: true,
    type: 'adaptive_crystallizer_status',
    entries: entries.length,
    active_cooldowns: active,
    state_path: path.relative(ROOT, STATE_PATH).replace(/\\/g, '/'),
    log_path: path.relative(ROOT, LOG_PATH).replace(/\\/g, '/')
  };
}

function usage() {
  process.stdout.write(
    'Usage:\n' +
    '  node systems/autonomy/adaptive_crystallizer.js run [YYYY-MM-DD]\n' +
    '  node systems/autonomy/adaptive_crystallizer.js status\n'
  );
}

function main() {
  const cmd = String(process.argv[2] || '').trim().toLowerCase();
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    usage();
    return;
  }
  if (cmd === 'run') {
    process.stdout.write(JSON.stringify(run(process.argv[3] || null)) + '\n');
    return;
  }
  if (cmd === 'status') {
    process.stdout.write(JSON.stringify(status()) + '\n');
    return;
  }
  process.stdout.write(JSON.stringify({ ok: false, error: `unknown_command:${cmd}` }) + '\n');
  process.exit(2);
}

if (require.main === module) {
  main();
}

module.exports = {
  run,
  status,
  evaluateHabitCandidates,
  evaluateReflexCandidates,
  generalityScore
};
