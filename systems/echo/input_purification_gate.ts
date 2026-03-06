#!/usr/bin/env node
'use strict';
export {};

const crypto = require('crypto');

type AnyObj = Record<string, any>;

const CLASSIFICATIONS = new Set([
  'constructive_aligned',
  'distress_self_doubt',
  'destructive_instruction',
  'contradictory_belief'
]);

function clampNumber(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function clampInt(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

function cleanText(v: unknown, maxLen = 1200) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeToken(v: unknown, maxLen = 120) {
  return cleanText(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.:/-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function sha16(seed: string) {
  return crypto.createHash('sha256').update(String(seed || ''), 'utf8').digest('hex').slice(0, 16);
}

function nowIso() {
  return new Date().toISOString();
}

function dateOnly(v: unknown) {
  const raw = String(v || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  return nowIso().slice(0, 10);
}

function toBool(v: unknown, fallback = false) {
  if (v == null) return fallback;
  const raw = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function parseRegexList(rows: unknown, fallback: string[]) {
  const src = Array.isArray(rows) ? rows : fallback;
  const out: RegExp[] = [];
  for (const row of src) {
    const text = String(row || '').trim();
    if (!text) continue;
    try {
      out.push(new RegExp(text, 'i'));
    } catch {
      continue;
    }
  }
  return out;
}

function countRegexHits(blob: string, patterns: RegExp[]) {
  let hits = 0;
  for (const rx of patterns) {
    if (rx.test(blob)) hits += 1;
  }
  return hits;
}

function defaultGatePolicy() {
  return {
    version: '1.0',
    enabled: true,
    shadow_only: true,
    allow_user_override_classification: true,
    max_text_chars: 1400,
    max_reason_codes: 8,
    thresholds: {
      destructive: 0.18,
      distress: 0.16,
      contradictory: 0.24
    },
    pattern_weights: {
      base_hit: 0.18,
      imperative_bonus: 0.1,
      contradiction_bonus: 0.08
    },
    patterns: {
      constructive: [
        '\\b(build|improve|learn|help|support|create|design|analyze|clarify|fix|stabilize|align)\\b',
        '\\b(goal|objective|plan|safe|quality|reliable|healthy|useful)\\b'
      ],
      distress: [
        '\\b(i\\s+can.t|i\\s+cannot|i\\s+failed|i\\s+am\\s+stuck|overwhelmed|anxious|afraid|burned\\s*out|self\\s*doubt)\\b',
        '\\b(hopeless|worthless|not\\s+good\\s+enough|panic|depressed)\\b'
      ],
      destructive: [
        '\\b(hurt|harm|destroy|sabotage|exploit|steal|override\\s+safety|disable\\s+guards?|bypass\\s+policy|self\\s*terminate)\\b',
        '\\b(exfiltrate|wipe\\s+data|malware|ransom|dos|ddos|break\\s+out|escape\\s+confinement)\\b'
      ],
      contradictory: [
        '\\b(i\\s+believe|my\\s+belief|i\\s+think)\\b.*\\b(but|however|although|yet)\\b',
        '\\b(on\\s+the\\s+other\\s+hand|at\\s+the\\s+same\\s+time)\\b'
      ]
    },
    beliefs: {
      default_integration: true,
      max_candidates_per_input: 4,
      min_statement_chars: 12,
      max_statement_chars: 260
    },
    governance: {
      hard_block_destructive: true,
      enforce_user_sovereignty: true,
      allow_coercive_steering: false
    }
  };
}

function mergeGatePolicy(raw: AnyObj = {}) {
  const base = defaultGatePolicy();
  const thresholds = raw.thresholds && typeof raw.thresholds === 'object' ? raw.thresholds : {};
  const weights = raw.pattern_weights && typeof raw.pattern_weights === 'object' ? raw.pattern_weights : {};
  const patterns = raw.patterns && typeof raw.patterns === 'object' ? raw.patterns : {};
  const beliefs = raw.beliefs && typeof raw.beliefs === 'object' ? raw.beliefs : {};
  const governance = raw.governance && typeof raw.governance === 'object' ? raw.governance : {};
  return {
    version: cleanText(raw.version || base.version, 32) || '1.0',
    enabled: toBool(raw.enabled, base.enabled),
    shadow_only: toBool(raw.shadow_only, base.shadow_only),
    allow_user_override_classification: toBool(
      raw.allow_user_override_classification,
      base.allow_user_override_classification
    ),
    max_text_chars: clampInt(raw.max_text_chars, 200, 5000, base.max_text_chars),
    max_reason_codes: clampInt(raw.max_reason_codes, 1, 32, base.max_reason_codes),
    thresholds: {
      destructive: clampNumber(thresholds.destructive, 0.05, 0.99, base.thresholds.destructive),
      distress: clampNumber(thresholds.distress, 0.05, 0.99, base.thresholds.distress),
      contradictory: clampNumber(thresholds.contradictory, 0.05, 0.99, base.thresholds.contradictory)
    },
    pattern_weights: {
      base_hit: clampNumber(weights.base_hit, 0.01, 1, base.pattern_weights.base_hit),
      imperative_bonus: clampNumber(weights.imperative_bonus, 0, 1, base.pattern_weights.imperative_bonus),
      contradiction_bonus: clampNumber(weights.contradiction_bonus, 0, 1, base.pattern_weights.contradiction_bonus)
    },
    patterns: {
      constructive: parseRegexList(patterns.constructive, base.patterns.constructive),
      distress: parseRegexList(patterns.distress, base.patterns.distress),
      destructive: parseRegexList(patterns.destructive, base.patterns.destructive),
      contradictory: parseRegexList(patterns.contradictory, base.patterns.contradictory)
    },
    beliefs: {
      default_integration: toBool(beliefs.default_integration, base.beliefs.default_integration),
      max_candidates_per_input: clampInt(
        beliefs.max_candidates_per_input,
        1,
        24,
        base.beliefs.max_candidates_per_input
      ),
      min_statement_chars: clampInt(
        beliefs.min_statement_chars,
        4,
        400,
        base.beliefs.min_statement_chars
      ),
      max_statement_chars: clampInt(
        beliefs.max_statement_chars,
        40,
        1200,
        base.beliefs.max_statement_chars
      )
    },
    governance: {
      hard_block_destructive: toBool(
        governance.hard_block_destructive,
        base.governance.hard_block_destructive
      ),
      enforce_user_sovereignty: toBool(
        governance.enforce_user_sovereignty,
        base.governance.enforce_user_sovereignty
      ),
      allow_coercive_steering: toBool(
        governance.allow_coercive_steering,
        base.governance.allow_coercive_steering
      )
    }
  };
}

function estimateScores(rawText: string, cfg: AnyObj) {
  const blob = String(rawText || '').toLowerCase();
  const imperative = /\b(do|make|force|must|need to|should|disable|bypass|override)\b/.test(blob) ? 1 : 0;
  const contradiction = /\b(but|however|although|yet|on the other hand)\b/.test(blob) ? 1 : 0;
  const hit = (name: string) => countRegexHits(blob, cfg.patterns[name] || []);
  const withWeight = (hits: number, extras = 0) => Math.max(0, Math.min(1, (hits * cfg.pattern_weights.base_hit) + extras));
  return {
    constructive: withWeight(hit('constructive')),
    distress: withWeight(hit('distress')),
    destructive: withWeight(hit('destructive'), imperative ? cfg.pattern_weights.imperative_bonus : 0),
    contradictory: withWeight(
      hit('contradictory'),
      contradiction ? cfg.pattern_weights.contradiction_bonus : 0
    )
  };
}

function extractBeliefCandidates(input: AnyObj, cfg: AnyObj = {}) {
  const text = cleanText(input && (input.text || input.content || input.message) || '', cfg.max_text_chars || 1200);
  if (!text) return [];
  const maxCandidates = clampInt(cfg.max_candidates_per_input, 1, 24, 4);
  const minChars = clampInt(cfg.min_statement_chars, 4, 400, 12);
  const maxChars = clampInt(cfg.max_statement_chars, 40, 1200, 260);
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((row: string) => cleanText(row, maxChars))
    .filter(Boolean);
  const out: AnyObj[] = [];
  for (const row of sentences) {
    if (out.length >= maxCandidates) break;
    const lower = row.toLowerCase();
    if (!/\b(i believe|my belief|we should|it is important|i value|we value)\b/.test(lower)) continue;
    if (row.length < minChars) continue;
    out.push({
      belief_statement: row,
      trit_label: 'true',
      confidence: 0.66,
      default_integration: cfg.default_integration === true
    });
  }
  if (!out.length) return [];
  return out.map((row, idx) => ({
    ...row,
    belief_id: `ebl_${sha16(`${row.belief_statement}|${idx}`)}`
  }));
}

function normalizeExplicitClassification(value: unknown) {
  const token = normalizeToken(value, 120);
  if (CLASSIFICATIONS.has(token)) return token;
  return null;
}

function isCompiledPolicy(policyRaw: AnyObj = {}) {
  const patterns = policyRaw && policyRaw.patterns && typeof policyRaw.patterns === 'object'
    ? policyRaw.patterns
    : {};
  const sample = Array.isArray(patterns.constructive) ? patterns.constructive[0] : null;
  return sample instanceof RegExp;
}

function classifyInput(inputRaw: AnyObj, policyRaw: AnyObj = {}) {
  const cfg = isCompiledPolicy(policyRaw) ? policyRaw : mergeGatePolicy(policyRaw);
  const text = cleanText(inputRaw && (inputRaw.text || inputRaw.content || inputRaw.message) || '', cfg.max_text_chars);
  const explicit = cfg.allow_user_override_classification === true
    ? normalizeExplicitClassification(inputRaw && inputRaw.classification)
    : null;
  const scores = estimateScores(text, cfg);
  const reasonCodes: string[] = [];
  let classification = explicit || 'constructive_aligned';

  if (!explicit) {
    if (scores.destructive >= cfg.thresholds.destructive) classification = 'destructive_instruction';
    else if (scores.distress >= cfg.thresholds.distress) classification = 'distress_self_doubt';
    else if (scores.contradictory >= cfg.thresholds.contradictory) classification = 'contradictory_belief';
    else classification = 'constructive_aligned';
  }

  if (explicit) reasonCodes.push('classification_user_declared');
  if (scores.destructive >= cfg.thresholds.destructive) reasonCodes.push('destructive_score_triggered');
  if (scores.distress >= cfg.thresholds.distress) reasonCodes.push('distress_score_triggered');
  if (scores.contradictory >= cfg.thresholds.contradictory) reasonCodes.push('contradictory_score_triggered');

  const beliefCandidates = extractBeliefCandidates(inputRaw, cfg.beliefs);

  const result: AnyObj = {
    classification,
    scores: {
      constructive: Number(scores.constructive.toFixed(4)),
      distress: Number(scores.distress.toFixed(4)),
      destructive: Number(scores.destructive.toFixed(4)),
      contradictory: Number(scores.contradictory.toFixed(4))
    },
    route: {
      training: false,
      mirror_support: false,
      doctor_review: false,
      security_review: false,
      belief_review: false,
      belief_update: false
    },
    blocked: false,
    decision: 'quarantined_for_review',
    reason_codes: reasonCodes.slice(0, cfg.max_reason_codes),
    belief_candidates: beliefCandidates
  };

  if (classification === 'constructive_aligned') {
    result.route.training = true;
    result.route.belief_update = beliefCandidates.length > 0;
    result.decision = 'purified_and_amplified';
  } else if (classification === 'distress_self_doubt') {
    result.route.mirror_support = true;
    result.route.doctor_review = true;
    result.decision = 'support_reflection_lane';
  } else if (classification === 'destructive_instruction') {
    result.route.security_review = true;
    result.route.doctor_review = true;
    result.blocked = cfg.governance.hard_block_destructive === true;
    result.decision = result.blocked ? 'blocked_destructive' : 'review_destructive';
  } else {
    result.route.belief_review = true;
    result.decision = 'belief_quarantine_review';
  }

  if (cfg.governance.enforce_user_sovereignty === true && cfg.governance.allow_coercive_steering !== true) {
    result.reason_codes.push('sovereignty_guard_active');
  }

  result.reason_codes = result.reason_codes.slice(0, cfg.max_reason_codes);
  return result;
}

function purifyInputs(inputsRaw: unknown, policyRaw: AnyObj = {}, meta: AnyObj = {}) {
  const cfg = isCompiledPolicy(policyRaw) ? policyRaw : mergeGatePolicy(policyRaw);
  const rows = Array.isArray(inputsRaw) ? inputsRaw : (inputsRaw ? [inputsRaw] : []);
  const dateStr = dateOnly(meta.date || nowIso());
  const runId = normalizeToken(meta.run_id || '', 120) || `echo_${dateStr}_${sha16(String(Date.now()))}`;
  const outputRows: AnyObj[] = [];
  const routes = {
    training: [] as AnyObj[],
    mirror_support: [] as AnyObj[],
    doctor_review: [] as AnyObj[],
    security_review: [] as AnyObj[],
    belief_review: [] as AnyObj[],
    belief_update: [] as AnyObj[]
  };

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i] && typeof rows[i] === 'object' ? rows[i] : { text: String(rows[i] || '') };
    const text = cleanText(row.text || row.content || row.message || '', cfg.max_text_chars);
    if (!text) continue;
    const inputId = normalizeToken(row.id || '', 120)
      || `ein_${sha16(`${runId}|${i}|${text.slice(0, 80)}`)}`;
    const classified = classifyInput(row, cfg);
    const entry: AnyObj = {
      id: inputId,
      ts: nowIso(),
      date: dateStr,
      source: normalizeToken(row.source || meta.source || 'user_input', 120) || 'user_input',
      modality: normalizeToken(row.modality || 'text', 80) || 'text',
      objective_id: normalizeToken(row.objective_id || meta.objective_id || '', 120) || null,
      text,
      classification: classified.classification,
      decision: classified.decision,
      blocked: classified.blocked === true,
      scores: classified.scores,
      reason_codes: classified.reason_codes,
      route: classified.route,
      belief_candidates: classified.belief_candidates
    };
    outputRows.push(entry);

    if (entry.route.training) routes.training.push(entry);
    if (entry.route.mirror_support) routes.mirror_support.push(entry);
    if (entry.route.doctor_review) routes.doctor_review.push(entry);
    if (entry.route.security_review) routes.security_review.push(entry);
    if (entry.route.belief_review) routes.belief_review.push(entry);
    if (entry.route.belief_update) routes.belief_update.push(entry);
  }

  const summary = {
    total: outputRows.length,
    constructive_aligned: outputRows.filter((row) => row.classification === 'constructive_aligned').length,
    distress_self_doubt: outputRows.filter((row) => row.classification === 'distress_self_doubt').length,
    destructive_instruction: outputRows.filter((row) => row.classification === 'destructive_instruction').length,
    contradictory_belief: outputRows.filter((row) => row.classification === 'contradictory_belief').length,
    blocked: outputRows.filter((row) => row.blocked === true).length,
    belief_candidates: outputRows.reduce(
      (sum, row) => sum + (Array.isArray(row.belief_candidates) ? row.belief_candidates.length : 0),
      0
    )
  };

  return {
    ok: true,
    type: 'echo_input_purification',
    ts: nowIso(),
    date: dateStr,
    run_id: runId,
    shadow_only: cfg.shadow_only === true,
    policy_version: cfg.version,
    summary,
    routes,
    rows: outputRows
  };
}

module.exports = {
  defaultGatePolicy,
  mergeGatePolicy,
  extractBeliefCandidates,
  classifyInput,
  purifyInputs
};
