#!/usr/bin/env node
/**
 * eyes_insight.js - Eyes → Proposals bridge (deterministic)
 *
 * Reads ONLY:
 *   state/sensory/eyes/raw/YYYY-MM-DD.jsonl
 *
 * Writes/merges:
 *   state/sensory/proposals/YYYY-MM-DD.json
 *
 * Goals:
 * - Deterministic, no LLM
 * - Produce a small number of proposals from external_item events
 * - Add explicit eye attribution for outcome loops:
 *   evidence_ref includes "eye:<id>"
 *
 * Commands:
 *   node habits/scripts/eyes_insight.js run [YYYY-MM-DD] [--max=N]
 *
 * Env overrides (for tests):
 *   SENSORY_TEST_DIR=/path/to/temp_state_sensory
 *
 * Notes:
 * - This script does NOT execute anything. It only proposes.
 * - It tolerates proposals files that are either:
 *   [ ... ] (array)
 *   { proposals: [ ... ] } (wrapper)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { loadActiveDirectives } = require('../../lib/directive_resolver.js');

const testDir = process.env.SENSORY_TEST_DIR;
const SENSORY_DIR = testDir || path.join(__dirname, '..', '..', 'state', 'sensory');
const EYES_RAW_DIR = path.join(SENSORY_DIR, 'eyes', 'raw');
const PROPOSALS_DIR = path.join(SENSORY_DIR, 'proposals');
const EYES_CONFIG_PATH = path.join(__dirname, '..', '..', 'config', 'external_eyes.json');
const EYES_STATE_REGISTRY_PATH = path.join(__dirname, '..', '..', 'state', 'sensory', 'eyes', 'registry.json');

const SENSORY_MIN_RELEVANCE_SCORE = Number(process.env.SENSORY_MIN_RELEVANCE_SCORE || 42);
const SENSORY_MIN_DIRECTIVE_FIT = Number(process.env.SENSORY_MIN_DIRECTIVE_FIT || 25);
const SENSORY_MIN_ACTIONABILITY_SCORE = Number(process.env.SENSORY_MIN_ACTIONABILITY_SCORE || 45);
const SENSORY_MIN_EYE_SCORE_EMA = Number(process.env.SENSORY_MIN_EYE_SCORE_EMA || 40);
const SENSORY_DISALLOWED_PARSER_TYPES = new Set(
  String(process.env.SENSORY_DISALLOWED_PARSER_TYPES || 'stub')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean)
);

const FIT_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'into', 'through', 'that', 'this', 'those', 'these', 'your', 'you',
  'their', 'our', 'are', 'was', 'were', 'been', 'being', 'have', 'has', 'had', 'will', 'would', 'should',
  'could', 'must', 'can', 'not', 'all', 'any', 'only', 'each', 'per', 'but', 'its', 'it', 'as', 'at', 'on',
  'to', 'in', 'of', 'or', 'an', 'a', 'by'
]);
const BUSINESS_MARKERS = new Set([
  'income', 'revenue', 'wealth', 'billionaire', 'venture', 'ventures', 'business', 'market', 'growth',
  'scalable', 'scale', 'automation', 'automated', 'system', 'systems', 'efficiency', 'monetize', 'profit',
  'equity', 'compounding', 'asset', 'assets', 'cashflow', 'recurring', 'leverage'
]);
const CAPABILITY_MARKERS = new Set([
  'ai', 'llm', 'agent', 'agents', 'automation', 'autonomous', 'productivity', 'devtools', 'infra', 'security',
  'orchestration', 'routing', 'latency', 'throughput', 'benchmark', 'optimization', 'startup'
]);
const ACTION_VERB_RE = /\b(build|implement|ship|deploy|automate|optimize|test|measure|reduce|increase|create|launch)\b/i;
const NOISE_MARKERS = [
  'rumor',
  'speculation',
  'wishlist',
  'top 10',
  'roundup',
  'viral',
  'drama'
];

function ensureDirs() {
  [EYES_RAW_DIR, PROPOSALS_DIR].forEach((dir) => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  });
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function sha16(str) {
  return crypto.createHash('sha256').update(String(str)).digest('hex').slice(0, 16);
}

function readJsonlSafe(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
  const out = [];
  for (const line of lines) {
    try {
      out.push(JSON.parse(line));
    } catch (_) {
      // ignore malformed lines (append-only logs sometimes include partial lines on crash)
    }
  }
  return out;
}

function loadExistingProposals(dateStr) {
  const p = path.join(PROPOSALS_DIR, `${dateStr}.json`);
  if (!fs.existsSync(p)) return { path: p, proposals: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (Array.isArray(raw)) return { path: p, proposals: raw };
    if (raw && Array.isArray(raw.proposals)) return { path: p, proposals: raw.proposals };
    // Unknown shape – treat as empty (but don't delete it; we overwrite with array for correctness)
    return { path: p, proposals: [] };
  } catch (_) {
    return { path: p, proposals: [] };
  }
}

function clamp(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return min;
  if (x < min) return min;
  if (x > max) return max;
  return x;
}

function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function saveProposalsArray(dateStr, proposals) {
  ensureDirs();
  const p = path.join(PROPOSALS_DIR, `${dateStr}.json`);
  fs.writeFileSync(p, JSON.stringify(proposals, null, 2));
  return p;
}

function normalizeText(s) {
  return String(s || '').trim();
}

function normalizeFitText(s) {
  return normalizeText(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function tokenizeFitText(s) {
  const norm = normalizeFitText(s);
  if (!norm) return [];
  return norm
    .split(' ')
    .filter(t => t.length >= 3)
    .filter(t => !FIT_STOPWORDS.has(t))
    .filter(t => !/^\d+$/.test(t));
}

function toStem(token) {
  const t = normalizeText(token);
  if (t.length <= 5) return t;
  return t.slice(0, 5);
}

function asStringArray(v) {
  if (Array.isArray(v)) return v.map(x => normalizeText(x)).filter(Boolean);
  if (typeof v === 'string') {
    const s = normalizeText(v);
    return s ? [s] : [];
  }
  return [];
}

function uniqSorted(arr) {
  return Array.from(new Set(arr)).sort();
}

function loadEyesMap() {
  const out = new Map();
  const cfg = readJsonSafe(EYES_CONFIG_PATH, {});
  const state = readJsonSafe(EYES_STATE_REGISTRY_PATH, {});
  const cfgEyes = Array.isArray(cfg && cfg.eyes) ? cfg.eyes : [];
  const stateEyes = Array.isArray(state && state.eyes) ? state.eyes : [];

  for (const e of cfgEyes) {
    if (!e || !e.id) continue;
    out.set(String(e.id), { ...e });
  }
  for (const e of stateEyes) {
    if (!e || !e.id) continue;
    const id = String(e.id);
    out.set(id, { ...(out.get(id) || {}), ...e });
  }
  return out;
}

function loadDirectiveFitProfile() {
  let directives = [];
  try {
    directives = loadActiveDirectives({ allowMissing: true });
  } catch (_) {
    return {
      available: false,
      active_directive_ids: [],
      positive_phrases: [],
      negative_phrases: [],
      positive_tokens: [],
      negative_tokens: []
    };
  }

  const strategic = directives.filter((d) => {
    const id = normalizeText(d && d.id);
    if (/^T0[_-]/i.test(id) || /^T0$/i.test(id)) return false;
    const entryTier = Number(d && d.tier);
    const metaTier = Number(d && d.data && d.data.metadata && d.data.metadata.tier);
    const tier = Number.isFinite(entryTier) ? entryTier : metaTier;
    return Number.isFinite(tier) ? tier >= 1 : true;
  });
  const positivePhrases = [];
  const negativePhrases = [];
  const activeIds = [];

  for (const d of strategic) {
    const data = d && d.data ? d.data : {};
    const meta = data && data.metadata ? data.metadata : {};
    const intent = data && data.intent ? data.intent : {};
    const scope = data && data.scope ? data.scope : {};
    const success = data && data.success_metrics ? data.success_metrics : {};
    activeIds.push(normalizeText(d.id || meta.id));

    positivePhrases.push(...asStringArray(meta.description));
    positivePhrases.push(...asStringArray(intent.primary));
    positivePhrases.push(...asStringArray(scope.included));
    positivePhrases.push(...asStringArray(success.leading));
    positivePhrases.push(...asStringArray(success.lagging));

    negativePhrases.push(...asStringArray(scope.excluded));
  }

  const posPhrasesNorm = uniqSorted(positivePhrases.map(normalizeFitText).filter(x => x.length >= 4));
  const negPhrasesNorm = uniqSorted(negativePhrases.map(normalizeFitText).filter(x => x.length >= 4));
  const posTokenSet = new Set();
  const negTokenSet = new Set();

  for (const p of posPhrasesNorm) {
    for (const t of tokenizeFitText(p)) posTokenSet.add(t);
  }
  for (const p of negPhrasesNorm) {
    for (const t of tokenizeFitText(p)) negTokenSet.add(t);
  }
  for (const t of posTokenSet) {
    if (negTokenSet.has(t)) negTokenSet.delete(t);
  }

  return {
    available: activeIds.length > 0 && posTokenSet.size > 0,
    active_directive_ids: uniqSorted(activeIds.filter(Boolean)),
    positive_phrases: posPhrasesNorm,
    negative_phrases: negPhrasesNorm,
    positive_tokens: uniqSorted(Array.from(posTokenSet)),
    negative_tokens: uniqSorted(Array.from(negTokenSet))
  };
}

// Simple deterministic "usefulness" heuristics
function scoreItem(item) {
  // 0..100
  let score = 0;
  const title = normalizeText(item.title);
  const url = normalizeText(item.url);
  const topics = Array.isArray(item.topics) ? item.topics : [];
  const preview = normalizeText(item.content_preview);

  if (url.startsWith('http')) score += 10;
  if (title.length >= 12) score += 15;
  if (title.length >= 24) score += 10;
  if (topics.length > 0) score += Math.min(20, topics.length * 5);
  if (preview.length >= 40) score += 10;

  // penalize obviously noisy stub markers if any
  if (/\[stub\]/i.test(title)) score -= 10;
  if (/lorem ipsum/i.test(preview)) score -= 20;

  // clamp
  if (score < 0) score = 0;
  if (score > 100) score = 100;
  return score;
}

function qualityTier(score) {
  const s = Number(score);
  if (!Number.isFinite(s)) return 'unknown';
  if (s >= 75) return 'high';
  if (s >= 50) return 'medium';
  return 'low';
}

function tokenHits(tokens, directiveTokens) {
  const tokenSet = new Set(tokens);
  const stemSet = new Set(tokens.map(toStem));
  const hits = [];
  for (const tok of directiveTokens) {
    if (tokenSet.has(tok)) {
      hits.push(tok);
      continue;
    }
    const stem = toStem(tok);
    if (stem && stemSet.has(stem)) hits.push(tok);
  }
  return hits;
}

function assessDirectiveFitItem(item, profile) {
  if (!profile || profile.available !== true) {
    return {
      pass: true,
      score: 100,
      matched_positive: [],
      matched_negative: [],
      reasons: ['directive_profile_unavailable']
    };
  }

  const text = normalizeFitText([
    normalizeText(item.title),
    normalizeText(item.url),
    normalizeText(item.content_preview)
  ].join(' '));
  const tokens = tokenizeFitText(text);
  const businessHits = tokens.filter(t => BUSINESS_MARKERS.has(t) || BUSINESS_MARKERS.has(toStem(t)));
  const capabilityHits = tokens.filter(t => CAPABILITY_MARKERS.has(t) || CAPABILITY_MARKERS.has(toStem(t)));
  const markerHits = uniqSorted([...businessHits, ...capabilityHits]);
  const posPhraseHits = profile.positive_phrases.filter(ph => text.includes(ph));
  const negPhraseHits = profile.negative_phrases.filter(ph => text.includes(ph));
  const posTokenHits = tokenHits(tokens, profile.positive_tokens);
  const negTokenHits = tokenHits(tokens, profile.negative_tokens);

  let score = 30;
  score += posPhraseHits.length * 18;
  score += Math.min(30, posTokenHits.length * 5);
  score += Math.min(12, markerHits.length * 4);
  score -= negPhraseHits.length * 20;
  score -= Math.min(24, negTokenHits.length * 6);

  const finalScore = clamp(Math.round(score), 0, 100);
  const reasons = [];
  const hasPositive = posPhraseHits.length > 0 || posTokenHits.length > 0;
  const hasBusiness = businessHits.length > 0;
  const hasCapability = capabilityHits.length >= 2;
  const hasMarker = hasBusiness || hasCapability;
  if (!hasPositive) reasons.push('no_directive_alignment');
  if (!hasMarker) reasons.push('no_business_marker');
  if (negPhraseHits.length > 0 || negTokenHits.length > 0) reasons.push('matches_excluded_scope');
  const pass = hasMarker && finalScore >= SENSORY_MIN_DIRECTIVE_FIT;
  if (!pass) reasons.push('below_min_directive_fit');

  return {
    pass,
    score: finalScore,
    matched_positive: uniqSorted([...posPhraseHits, ...posTokenHits, ...markerHits]).slice(0, 5),
    matched_negative: uniqSorted([...negPhraseHits, ...negTokenHits]).slice(0, 5),
    reasons
  };
}

function assessItemRelevance(item, eye, directiveProfile) {
  const itemScore = scoreItem(item);
  const directiveFit = assessDirectiveFitItem(item, directiveProfile);
  const title = normalizeText(item.title);
  let score = Math.round((itemScore * 0.55) + (directiveFit.score * 0.45));
  const reasons = [];
  let hardBlock = false;

  if (/\[stub\]/i.test(title)) {
    hardBlock = true;
    reasons.push('stub_title');
  }

  if (eye) {
    const parserType = normalizeText(eye.parser_type).toLowerCase();
    const status = normalizeText(eye.status).toLowerCase();
    const eyeScoreEma = Number(eye.score_ema);

    if (parserType && SENSORY_DISALLOWED_PARSER_TYPES.has(parserType)) {
      hardBlock = true;
      reasons.push(`parser_disallowed:${parserType}`);
    }
    if (status === 'dormant') {
      hardBlock = true;
      reasons.push('eye_dormant');
    } else if (status === 'probation') {
      score -= 10;
      reasons.push('eye_probation');
    }
    if (Number.isFinite(eyeScoreEma) && eyeScoreEma < SENSORY_MIN_EYE_SCORE_EMA) {
      score -= 8;
      reasons.push('eye_score_ema_low');
    }
  } else {
    reasons.push('eye_unknown');
  }

  if (!directiveFit.pass && itemScore < 70) {
    reasons.push('directive_fit_low');
  }

  const finalScore = clamp(score, 0, 100);
  const pass = !hardBlock
    && finalScore >= SENSORY_MIN_RELEVANCE_SCORE
    && (directiveFit.pass || itemScore >= 70);
  if (!pass && finalScore < SENSORY_MIN_RELEVANCE_SCORE) reasons.push('below_min_relevance');

  return {
    pass,
    relevance_score: finalScore,
    relevance_tier: qualityTier(finalScore),
    signal_quality_score: itemScore,
    signal_quality_tier: qualityTier(itemScore),
    directive_fit_score: directiveFit.score,
    directive_fit_pass: directiveFit.pass,
    directive_fit_positive: directiveFit.matched_positive,
    directive_fit_negative: directiveFit.matched_negative,
    reasons
  };
}

function assessItemActionability(item, analysis) {
  const title = normalizeText(item.title);
  const preview = normalizeText(item.content_preview);
  const url = normalizeText(item.url);
  const topics = Array.isArray(item.topics) ? item.topics : [];
  const relevance = Number(analysis && analysis.relevance_score);
  const directiveFitPass = analysis && analysis.directive_fit_pass === true;
  const reasons = [];

  let score = 0;
  if (directiveFitPass) score += 18;
  else reasons.push('directive_fit_not_passed');

  if (Number.isFinite(relevance)) score += clamp(Math.round((relevance - 30) * 0.5), 0, 35);

  if (ACTION_VERB_RE.test(title) || ACTION_VERB_RE.test(preview)) score += 16;
  else reasons.push('no_action_verb');

  if (topics.length >= 2) score += 8;
  else if (topics.length >= 1) score += 4;

  if (url.startsWith('https://')) score += 8;
  else if (url.startsWith('http://')) score += 4;
  else reasons.push('missing_source_url');

  const haystack = `${title.toLowerCase()} ${preview.toLowerCase()}`;
  const noiseHits = NOISE_MARKERS.filter(m => haystack.includes(m)).length;
  if (noiseHits > 0) {
    score -= noiseHits * 10;
    reasons.push('noise_marker');
  }

  const finalScore = clamp(score, 0, 100);
  const pass = finalScore >= SENSORY_MIN_ACTIONABILITY_SCORE;
  if (!pass) reasons.push('below_min_actionability');

  return {
    pass,
    actionability_score: finalScore,
    reasons
  };
}

function normalizeTaskText(s, maxLen = 160) {
  return normalizeText(s)
    .replace(/["`]/g, '')
    .replace(/\s+/g, ' ')
    .slice(0, maxLen);
}

function buildSuggestedNextCommand(item, analysis) {
  const title = normalizeTaskText(item.title || 'external intel', 90);
  const url = normalizeTaskText(item.url || '', 120);
  const topics = Array.isArray(item.topics)
    ? item.topics.map(t => normalizeTaskText(t, 20)).filter(Boolean).slice(0, 2)
    : [];
  const focus = topics.length ? ` Focus topics: ${topics.join(', ')}.` : '';
  const source = url ? ` Source: ${url}.` : '';
  const task = `Extract one implementable step from external intel: ${title}.${focus}${source}`.trim().slice(0, 220);
  const tokensEst = Number(analysis && analysis.relevance_score) >= 70 ? 1100 : 700;
  return `node systems/routing/route_execute.js --task="${task}" --tokens_est=${tokensEst} --repeats_14d=3 --errors_30d=0 --dry-run`;
}

function buildProposalFromItem(item, analysis, actionability) {
  // Prefer explicit eye_id from external_eyes raw events (stable attribution key)
  const eyeId = normalizeText(item.eye_id) || normalizeText(item.source) || 'unknown_eye';
  const url = normalizeText(item.url);
  const title = normalizeText(item.title) || 'External item';
  const topics = Array.isArray(item.topics) ? item.topics : [];
  const preview = normalizeText(item.content_preview);
  const signalScore = Number(analysis && analysis.signal_quality_score);
  const itemScore = Number.isFinite(signalScore) ? signalScore : scoreItem(item);
  const signalTier = qualityTier(itemScore);
  const relevanceScore = Number(analysis && analysis.relevance_score);
  const directiveFitScore = Number(analysis && analysis.directive_fit_score);
  const actionabilityScore = Number(actionability && actionability.actionability_score);

  // Stable key:
  // - If item_hash exists, use it (best)
  // - Else fall back to URL (acceptable)
  // IMPORTANT: do NOT include title/preview in the hash; those can change and cause ID churn.
  const itemHash = normalizeText(item.item_hash);
  const stableKey = itemHash || url || '';
  const h = sha16(`${eyeId}:${stableKey}`);

  // Proposal ID is deterministic and stable across runs & minor content changes
  const id = `EYE-${h}`;

  return {
    id,
    type: 'external_intel',
    title: `[Eyes:${eyeId}] ${title}`.slice(0, 120),
    evidence: [
      {
        source: 'eyes_raw',
        path: `state/sensory/eyes/raw/${item.collected_at ? String(item.collected_at).slice(0, 10) : 'YYYY-MM-DD'}.jsonl`,
        match: `${title} | ${url}`.slice(0, 200),
        // Keep attribution strictly machine-parseable (first token only)
        evidence_ref: `eye:${eyeId}`,
        // Store the rest as explicit fields so formatting changes never break attribution.
        evidence_url: url || null,
        evidence_item_hash: itemHash || null
      }
    ],
    expected_impact: (Number.isFinite(relevanceScore) && relevanceScore >= 75 && Number.isFinite(actionabilityScore) && actionabilityScore >= 70)
      ? 'high'
      : itemScore >= 60 ? 'medium' : 'low',
    risk: (analysis && analysis.directive_fit_pass === true && Number.isFinite(actionabilityScore) && actionabilityScore >= 60)
      ? 'low'
      : 'medium',
    validation: [
      'Extract one concrete build/change task from source',
      'Define measurable success check (artifact/log/test)',
      'Route a dry-run execution plan and verify gate outcome'
    ],
    suggested_next_command: buildSuggestedNextCommand(item, analysis),
    meta: {
      source_eye: eyeId,
      url,
      topics,
      // `score` is retained for compatibility with existing consumers.
      score: itemScore,
      signal_quality_score: itemScore,
      signal_quality_tier: signalTier,
      relevance_score: Number.isFinite(relevanceScore) ? relevanceScore : itemScore,
      relevance_tier: qualityTier(Number.isFinite(relevanceScore) ? relevanceScore : itemScore),
      directive_fit_score: Number.isFinite(directiveFitScore) ? directiveFitScore : null,
      directive_fit_pass: analysis ? analysis.directive_fit_pass === true : null,
      directive_fit_positive: analysis ? analysis.directive_fit_positive.slice(0, 5) : [],
      directive_fit_negative: analysis ? analysis.directive_fit_negative.slice(0, 5) : [],
      relevance_reasons: analysis ? analysis.reasons.slice(0, 5) : [],
      actionability_score: Number.isFinite(actionabilityScore) ? actionabilityScore : null,
      actionability_pass: actionability ? actionability.pass === true : null,
      actionability_reasons: actionability ? actionability.reasons.slice(0, 5) : [],
      preview: preview.slice(0, 200)
    }
  };
}

function hydrateExisting(existingProposal, incomingProposal) {
  const e = existingProposal && typeof existingProposal === 'object' ? existingProposal : {};
  const i = incomingProposal && typeof incomingProposal === 'object' ? incomingProposal : {};
  const eMeta = e.meta && typeof e.meta === 'object' ? e.meta : {};
  const iMeta = i.meta && typeof i.meta === 'object' ? i.meta : {};

  const fields = [
    'signal_quality_score',
    'signal_quality_tier',
    'relevance_score',
    'relevance_tier',
    'directive_fit_score',
    'directive_fit_pass',
    'directive_fit_positive',
    'directive_fit_negative',
    'relevance_reasons',
    'actionability_score',
    'actionability_pass',
    'actionability_reasons'
  ];

  let touched = false;
  const nextMeta = { ...eMeta };
  for (const key of fields) {
    const hasExisting = eMeta[key] != null && !(Array.isArray(eMeta[key]) && eMeta[key].length === 0);
    const hasIncoming = iMeta[key] != null;
    if (!hasExisting && hasIncoming) {
      nextMeta[key] = iMeta[key];
      touched = true;
    }
  }
  if (!touched) return { proposal: e, touched: false };
  return { proposal: { ...e, meta: nextMeta }, touched: true };
}

function mergeById(existing, incoming) {
  const index = new Map();
  const merged = existing.map((p, idx) => {
    const id = p && p.id ? String(p.id) : '';
    if (id) index.set(id, idx);
    return p;
  });

  let added = 0;
  let hydrated = 0;
  for (const p of incoming) {
    if (!p || !p.id) continue;
    const id = String(p.id);
    if (!index.has(id)) {
      merged.push(p);
      index.set(id, merged.length - 1);
      added += 1;
      continue;
    }
    const idx = index.get(id);
    const res = hydrateExisting(merged[idx], p);
    if (res.touched) {
      merged[idx] = res.proposal;
      hydrated += 1;
    }
  }
  return { merged, added, hydrated };
}

function generateEyeProposals(dateStr, maxCount = 5) {
  ensureDirs();
  const rawPath = path.join(EYES_RAW_DIR, `${dateStr}.jsonl`);
  const events = readJsonlSafe(rawPath);
  const directiveProfile = loadDirectiveFitProfile();
  const eyesMap = loadEyesMap();

  const items = events
    .filter(e => e && e.type === 'external_item')
    .map(e => e.item || e)
    .filter(i => i && typeof i === 'object');

  const analyses = items.map((item) => {
    const eyeId = normalizeText(item.eye_id) || normalizeText(item.source) || 'unknown_eye';
    const eye = eyesMap.get(eyeId) || null;
    const analysis = assessItemRelevance(item, eye, directiveProfile);
    const actionability = assessItemActionability(item, analysis);
    return { item, eyeId, analysis, actionability };
  });

  // Deduplicate by URL hash to avoid spamming same link
  const byUrl = new Map();
  for (const entry of analyses) {
    const item = entry.item;
    const url = normalizeText(item.url);
    if (!url) continue;
    const key = sha16(url);
    const prev = byUrl.get(key);
    if (!prev) {
      byUrl.set(key, entry);
    } else {
      // keep the higher relevance/actionability one deterministically
      const scoreCur = (Number(entry.analysis.relevance_score) * 0.7) + (Number(entry.actionability.actionability_score) * 0.3);
      const scorePrev = (Number(prev.analysis.relevance_score) * 0.7) + (Number(prev.actionability.actionability_score) * 0.3);
      if (scoreCur > scorePrev) byUrl.set(key, entry);
    }
  }

  const deduped = Array.from(byUrl.values());
  deduped.sort((a, b) => {
    const sa = (Number(a.analysis.relevance_score) * 0.7) + (Number(a.actionability.actionability_score) * 0.3);
    const sb = (Number(b.analysis.relevance_score) * 0.7) + (Number(b.actionability.actionability_score) * 0.3);
    if (sb !== sa) return sb - sa;
    // stable tie-breakers
    const ua = normalizeText(a.item.url);
    const ub = normalizeText(b.item.url);
    return ua.localeCompare(ub);
  });

  const rejected = deduped.filter(x => !(x.analysis.pass && x.actionability.pass));
  const accepted = deduped.filter(x => x.analysis.pass && x.actionability.pass);
  const proposals = accepted.slice(0, maxCount).map(x => buildProposalFromItem(x.item, x.analysis, x.actionability));
  return {
    rawPath,
    proposals,
    stats: {
      total_items: items.length,
      deduped_items: deduped.length,
      accepted_items: accepted.length,
      rejected_items: rejected.length,
      directive_profile_available: directiveProfile.available === true
    },
    rejected_samples: rejected.slice(0, 5).map((x) => ({
      eye_id: x.eyeId,
      title: normalizeText(x.item.title).slice(0, 80),
      relevance_score: x.analysis.relevance_score,
      actionability_score: x.actionability.actionability_score,
      reasons: [...x.analysis.reasons, ...x.actionability.reasons].slice(0, 4)
    }))
  };
}

function mergeIntoDailyProposals(dateStr, maxCount = 5) {
  const { proposals: existing, path: proposalsPath } = loadExistingProposals(dateStr);
  const generated = generateEyeProposals(dateStr, maxCount);
  const newOnes = generated.proposals;
  const rawPath = generated.rawPath;

  const mergedRes = mergeById(existing, newOnes);
  const merged = mergedRes.merged;

  const savedPath = saveProposalsArray(dateStr, merged);
  return {
    ok: true,
    date: dateStr,
    eyes_raw: rawPath,
    proposals_path: savedPath,
    existing_count: existing.length,
    added_count: mergedRes.added,
    hydrated_count: mergedRes.hydrated,
    total_count: merged.length,
    generated_stats: generated.stats,
    rejected_samples: generated.rejected_samples
  };
}

function parseArgs(argv) {
  const out = { cmd: null, date: null, max: 5 };
  const args = argv.slice(2);
  out.cmd = args[0] || null;
  // date can be second arg if not a flag
  if (args[1] && !String(args[1]).startsWith('--')) out.date = args[1];
  for (const a of args) {
    if (a.startsWith('--max=')) out.max = Number(a.split('=')[1]) || 5;
  }
  return out;
}

function main() {
  const { cmd, date, max } = parseArgs(process.argv);
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log('Eyes Insight (deterministic) - Eyes → Proposals bridge');
    console.log('');
    console.log('Usage:');
    console.log('  node habits/scripts/eyes_insight.js run [YYYY-MM-DD] [--max=N]');
    console.log('');
    console.log('Reads: state/sensory/eyes/raw/YYYY-MM-DD.jsonl');
    console.log('Writes: state/sensory/proposals/YYYY-MM-DD.json (array)');
    process.exit(0);
  }

  const dateStr = date || todayStr();
  if (cmd === 'run') {
    const res = mergeIntoDailyProposals(dateStr, max);
    console.log('═══════════════════════════════════════════════════════════');
    console.log('EYES INSIGHT - MERGE');
    console.log('═══════════════════════════════════════════════════════════');
    console.log(`Date: ${res.date}`);
    console.log(`Eyes raw: ${res.eyes_raw}`);
    console.log(`Proposals: ${res.proposals_path}`);
    console.log(`Existing: ${res.existing_count}`);
    console.log(`Added: ${res.added_count}`);
    console.log(`Hydrated: ${res.hydrated_count || 0}`);
    console.log(`Total: ${res.total_count}`);
    if (res.generated_stats) {
      console.log(`Accepted (this run): ${res.generated_stats.accepted_items}/${res.generated_stats.deduped_items}`);
      console.log(`Rejected (this run): ${res.generated_stats.rejected_items}`);
    }
    console.log('═══════════════════════════════════════════════════════════');
    process.exit(0);
  }

  console.error(`Unknown command: ${cmd}`);
  process.exit(1);
}

if (require.main === module) {
  main();
}

module.exports = {
  scoreItem,
  assessDirectiveFitItem,
  assessItemRelevance,
  assessItemActionability,
  buildProposalFromItem,
  generateEyeProposals,
  mergeIntoDailyProposals,
  loadExistingProposals,
  saveProposalsArray,
  readJsonlSafe
};
