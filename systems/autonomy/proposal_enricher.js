#!/usr/bin/env node
'use strict';

/**
 * proposal_enricher.js
 *
 * Deterministic proposal metadata/admission enrichment.
 * - Normalizes proposal meta scores used by autonomy gates.
 * - Adds admission preview (eligible + blocked reasons) per proposal.
 * - Produces daily admission summary for orchestration logs.
 *
 * Usage:
 *   node systems/autonomy/proposal_enricher.js run [YYYY-MM-DD] [--dry-run]
 *   node systems/autonomy/proposal_enricher.js --help
 */

const fs = require('fs');
const path = require('path');
const { loadActiveDirectives } = require('../../lib/directive_resolver.js');
const { resolveCatalogPath } = require('../../lib/eyes_catalog.js');
const {
  loadActiveStrategy,
  applyThresholdOverrides,
  effectiveAllowedRisks,
  strategyAllowsProposalType
} = require('../../lib/strategy_resolver.js');
const { loadOutcomeFitnessPolicy } = require('../../lib/outcome_fitness.js');

const ROOT = path.resolve(__dirname, '..', '..');
const SENSORY_DIR = process.env.SENSORY_TEST_DIR
  ? path.resolve(process.env.SENSORY_TEST_DIR)
  : path.join(ROOT, 'state', 'sensory');
const PROPOSALS_DIR = path.join(SENSORY_DIR, 'proposals');

const EYES_CONFIG_PATH = resolveCatalogPath(ROOT);
const EYES_REGISTRY_PATH = process.env.PROPOSAL_ENRICHER_EYES_REGISTRY
  ? path.resolve(process.env.PROPOSAL_ENRICHER_EYES_REGISTRY)
  : path.join(ROOT, 'state', 'sensory', 'eyes', 'registry.json');

const FIT_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'into', 'through', 'that', 'this', 'those', 'these', 'your', 'you',
  'their', 'our', 'are', 'was', 'were', 'been', 'being', 'have', 'has', 'had', 'will', 'would', 'should',
  'could', 'must', 'can', 'not', 'all', 'any', 'only', 'each', 'per', 'but', 'its', 'it', 'as', 'at', 'on',
  'to', 'in', 'of', 'or', 'an', 'a', 'by'
]);

const ACTION_VERB_RE = /\b(build|implement|fix|add|create|generate|optimize|refactor|automate|ship|deploy|test|measure|instrument|reduce|increase|stabilize)\b/i;
const OPPORTUNITY_MARKER_RE = /\b(opportunity|freelance|job|jobs|hiring|contract|contractor|gig|client|rfp|request for proposal|seeking|looking for)\b/i;
const META_COORDINATION_RE = /\b(review|prioritize|triage|health\s*check|high\s*leverage)\b/i;
const CONCRETE_TARGET_RE = /\b(file|script|collector|parser|endpoint|model|config|test|hook|queue|ledger|registry|adapter|workflow|routing|transport|fallback|sensor|retry|dns|network|probe|api|cache)\b/i;
const EXPLAINER_TITLE_RE = /^(why|what|how)\b/i;
const GENERIC_VALIDATION_RE = /\b(extract one concrete build\/change task from source|define measurable success check|route a dry-run execution plan)\b/i;
const GENERIC_ROUTE_TASK_RE = /--task=\"Extract one implementable step from external intel:/i;
const SUCCESS_METRIC_RE = /\b(metric|kpi|target|rate|count|latency|error|uptime|throughput|conversion|artifact|receipt|coverage|reply|interview|pass|fail|delta|percent|%|run|runs|check|checks|items_collected)\b/i;
const SUCCESS_TIMEBOUND_RE = /\b(\d+\s*(h|hr|hour|hours|d|day|days|w|week|weeks|min|mins|minute|minutes)|daily|weekly|monthly|quarterly)\b/i;
const DIRECTIVE_OBJECTIVE_ID_RE = /^T[0-9]_[A-Za-z0-9_]+$/;
const ARCHETYPE_RULES = [
  {
    key: 'reliability',
    regex: /\b(fail|failure|outage|error|retry|timeout|flaky|stabilize|reliab|uptime|collector|sensor|ingest|queue|backlog)\b/i,
    hints: ['reliability', 'uptime', 'systems']
  },
  {
    key: 'automation',
    regex: /\b(automate|automation|deterministic|orchestrat|pipeline|spine|workflow|throughput)\b/i,
    hints: ['automated', 'systems', 'efficiency']
  },
  {
    key: 'growth',
    regex: /\b(growth|income|revenue|mrr|compounding|scale|scalable|venture|asset)\b/i,
    hints: ['income', 'scalable', 'growth']
  },
  {
    key: 'measurement',
    regex: /\b(metric|measure|validation|proof|artifact|receipt|signal|score|quality)\b/i,
    hints: ['metrics', 'quality', 'validation']
  },
  {
    key: 'risk_control',
    regex: /\b(risk|guard|safety|compliance|policy|rollback|revert|downside)\b/i,
    hints: ['risk', 'return', 'assessment']
  }
];
const DISALLOWED_PARSER_TYPES = new Set(
  String(process.env.AUTONOMY_DISALLOWED_PARSER_TYPES || 'stub')
    .split(',')
    .map(s => String(s || '').trim().toLowerCase())
    .filter(Boolean)
);
const ALLOWED_RISKS = new Set(
  String(process.env.AUTONOMY_ALLOWED_RISKS || 'low')
    .split(',')
    .map(s => String(s || '').trim().toLowerCase())
    .filter(Boolean)
);
const AUTONOMY_OBJECTIVE_BINDING_REQUIRED = String(process.env.AUTONOMY_OBJECTIVE_BINDING_REQUIRED || '1') !== '0';
let STRATEGY_CACHE = undefined;

function strategyProfile() {
  if (STRATEGY_CACHE !== undefined) return STRATEGY_CACHE;
  STRATEGY_CACHE = loadActiveStrategy({ allowMissing: true });
  return STRATEGY_CACHE;
}

function thresholds() {
  const base = {
    min_signal_quality: Number(process.env.AUTONOMY_MIN_SIGNAL_QUALITY || 58),
    min_sensory_signal_score: Number(process.env.AUTONOMY_MIN_SENSORY_SIGNAL_SCORE || 45),
    min_sensory_relevance_score: Number(process.env.AUTONOMY_MIN_SENSORY_RELEVANCE_SCORE || 42),
    min_directive_fit: Number(process.env.AUTONOMY_MIN_DIRECTIVE_FIT || 40),
    min_actionability_score: Number(process.env.AUTONOMY_MIN_ACTIONABILITY_SCORE || 45),
    min_composite_eligibility: Number(process.env.AUTONOMY_MIN_COMPOSITE_ELIGIBILITY || 62),
    min_eye_score_ema: Number(process.env.AUTONOMY_MIN_EYE_SCORE_EMA || 45)
  };
  return applyThresholdOverrides(base, strategyProfile());
}

function effectiveAllowedRisksSet() {
  return effectiveAllowedRisks(ALLOWED_RISKS, strategyProfile());
}

function nowIso() { return new Date().toISOString(); }
function todayStr() { return new Date().toISOString().slice(0, 10); }

function usage() {
  console.log('Usage:');
  console.log('  node systems/autonomy/proposal_enricher.js run [YYYY-MM-DD] [--dry-run]');
  console.log('  node systems/autonomy/proposal_enricher.js --help');
}

function parseArgs(argv) {
  const out = { _: [] };
  for (const a of argv) {
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const eq = a.indexOf('=');
    if (eq === -1) out[a.slice(2)] = true;
    else out[a.slice(2, eq)] = a.slice(eq + 1);
  }
  return out;
}

function clamp(n, lo, hi) {
  const x = Number(n);
  if (!Number.isFinite(x)) return lo;
  if (x < lo) return lo;
  if (x > hi) return hi;
  return x;
}

function normalizeText(v) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
}

function normalizeFitText(v) {
  return normalizeText(v).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function tokenizeFitText(v) {
  const n = normalizeFitText(v);
  if (!n) return [];
  return n
    .split(' ')
    .filter(Boolean)
    .filter(t => t.length >= 3)
    .filter(t => !FIT_STOPWORDS.has(t))
    .filter(t => !/^\d+$/.test(t));
}

function toStem(token) {
  const t = normalizeText(token);
  if (t.length <= 5) return t;
  return t.slice(0, 5);
}

function uniq(arr) {
  return Array.from(new Set(arr));
}

function tier(score) {
  const s = Number(score);
  if (!Number.isFinite(s)) return 'unknown';
  if (s >= 75) return 'high';
  if (s >= 50) return 'medium';
  return 'low';
}

function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function loadProposalsForDate(dateStr) {
  const fp = path.join(PROPOSALS_DIR, `${dateStr}.json`);
  if (!fs.existsSync(fp)) return { exists: false, filePath: fp, container: null, proposals: [] };
  const raw = readJsonSafe(fp, []);
  if (Array.isArray(raw)) return { exists: true, filePath: fp, container: null, proposals: raw };
  if (raw && typeof raw === 'object' && Array.isArray(raw.proposals)) {
    return { exists: true, filePath: fp, container: raw, proposals: raw.proposals };
  }
  return { exists: true, filePath: fp, container: null, proposals: [] };
}

function writeJsonAtomic(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}

function saveProposalsForDate(filePath, container, proposals) {
  if (container && typeof container === 'object' && !Array.isArray(container)) {
    writeJsonAtomic(filePath, { ...container, proposals });
    return;
  }
  writeJsonAtomic(filePath, proposals);
}

function loadEyesMap() {
  const out = new Map();
  const cfg = readJsonSafe(EYES_CONFIG_PATH, {});
  const reg = readJsonSafe(EYES_REGISTRY_PATH, {});
  const cfgEyes = Array.isArray(cfg && cfg.eyes) ? cfg.eyes : [];
  const regEyes = Array.isArray(reg && reg.eyes) ? reg.eyes : [];
  for (const e of cfgEyes) {
    if (!e || !e.id) continue;
    out.set(String(e.id), { ...e });
  }
  for (const e of regEyes) {
    if (!e || !e.id) continue;
    const id = String(e.id);
    out.set(id, { ...(out.get(id) || {}), ...e });
  }
  return out;
}

function asStringArray(v) {
  if (Array.isArray(v)) return v.map(x => normalizeText(x)).filter(Boolean);
  if (typeof v === 'string') {
    const s = normalizeText(v);
    return s ? [s] : [];
  }
  return [];
}

function strategyMarkerTokens(strategy) {
  const s = strategy && typeof strategy === 'object' ? strategy : {};
  const objective = s.objective && typeof s.objective === 'object' ? s.objective : {};
  const parts = [
    objective.primary,
    objective.fitness_metric,
    ...(Array.isArray(objective.secondary) ? objective.secondary : []),
    ...(Array.isArray(s.tags) ? s.tags : [])
  ];
  const set = new Set();
  for (const part of parts) {
    const norm = normalizeFitText(part);
    if (!norm) continue;
    for (const tok of tokenizeFitText(norm)) set.add(tok);
  }
  return Array.from(set).sort();
}

function loadDirectiveProfile() {
  let directives = [];
  try {
    directives = loadActiveDirectives({ allowMissing: true });
  } catch {
    return {
      available: false,
      strategy_id: null,
      strategy_tokens: [],
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
    const tierVal = Number.isFinite(entryTier) ? entryTier : metaTier;
    return Number.isFinite(tierVal) ? tierVal >= 1 : true;
  });

  const positive = [];
  const negative = [];
  const ids = [];
  for (const d of strategic) {
    const data = d && d.data ? d.data : {};
    const meta = data && data.metadata ? data.metadata : {};
    const intent = data && data.intent ? data.intent : {};
    const scope = data && data.scope ? data.scope : {};
    const success = data && data.success_metrics ? data.success_metrics : {};
    ids.push(normalizeText(d.id || meta.id));
    positive.push(...asStringArray(meta.description));
    positive.push(...asStringArray(intent.primary));
    positive.push(...asStringArray(scope.included));
    positive.push(...asStringArray(success.leading));
    positive.push(...asStringArray(success.lagging));
    negative.push(...asStringArray(scope.excluded));
  }

  const posPhrases = uniq(positive.map(normalizeFitText).filter(x => x.length >= 4)).sort();
  const negPhrases = uniq(negative.map(normalizeFitText).filter(x => x.length >= 4)).sort();

  const posTokenSet = new Set();
  const negTokenSet = new Set();
  for (const p of posPhrases) for (const t of tokenizeFitText(p)) posTokenSet.add(t);
  for (const p of negPhrases) for (const t of tokenizeFitText(p)) negTokenSet.add(t);
  for (const t of posTokenSet) if (negTokenSet.has(t)) negTokenSet.delete(t);
  const strategy = strategyProfile();

  return {
    available: ids.length > 0 && posTokenSet.size > 0,
    strategy_id: strategy && strategy.id ? String(strategy.id) : null,
    strategy_tokens: strategyMarkerTokens(strategy),
    active_directive_ids: uniq(ids.filter(Boolean)).sort(),
    positive_phrases: posPhrases,
    negative_phrases: negPhrases,
    positive_tokens: Array.from(posTokenSet).sort(),
    negative_tokens: Array.from(negTokenSet).sort()
  };
}

function sourceEyeId(proposal) {
  const metaEye = normalizeText(proposal && proposal.meta && proposal.meta.source_eye);
  if (metaEye) return metaEye;
  if (Array.isArray(proposal && proposal.evidence)) {
    for (const ev of proposal.evidence) {
      const ref = normalizeText(ev && ev.evidence_ref);
      const m = ref.match(/\beye:([^\s]+)/);
      if (m) return normalizeText(m[1]);
    }
  }
  return 'unknown_eye';
}

function sanitizeDirectiveObjectiveId(v) {
  const id = normalizeText(v);
  if (!id) return '';
  if (!DIRECTIVE_OBJECTIVE_ID_RE.test(id)) return '';
  return id;
}

function activeDirectiveObjectiveIds(profile) {
  const ids = Array.isArray(profile && profile.active_directive_ids)
    ? profile.active_directive_ids
    : [];
  const out = [];
  const seen = new Set();
  for (const id of ids) {
    const clean = sanitizeDirectiveObjectiveId(id);
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
  }
  out.sort();
  return out;
}

function parseObjectiveIdFromEvidence(proposal, objectiveSet) {
  const evidence = Array.isArray(proposal && proposal.evidence) ? proposal.evidence : [];
  for (const row of evidence) {
    const ref = normalizeText(row && row.evidence_ref);
    if (!ref) continue;
    const pulseMatch = ref.match(/directive_pulse\/([A-Za-z0-9_]+)/i);
    const directiveMatch = ref.match(/\bdirective:([A-Za-z0-9_]+)/i);
    const fallbackMatch = ref.match(/\b(T[0-9]_[A-Za-z0-9_]+)\b/);
    const raw = normalizeText(
      (pulseMatch && pulseMatch[1])
      || (directiveMatch && directiveMatch[1])
      || (fallbackMatch && fallbackMatch[1])
    );
    const id = sanitizeDirectiveObjectiveId(raw);
    if (!id) continue;
    if (objectiveSet.size > 0 && !objectiveSet.has(id)) continue;
    return { objective_id: id, source: 'evidence_ref' };
  }
  return null;
}

function parseObjectiveIdFromCommand(proposal, objectiveSet) {
  const cmd = normalizeText(proposal && proposal.suggested_next_command);
  if (!cmd) return null;
  const match = cmd.match(/(?:^|\s)--id=(?:"([^"]+)"|'([^']+)'|([^\s]+))/);
  const raw = normalizeText(match && (match[1] || match[2] || match[3]));
  const id = sanitizeDirectiveObjectiveId(raw);
  if (!id) return null;
  if (objectiveSet.size > 0 && !objectiveSet.has(id)) return null;
  return { objective_id: id, source: 'suggested_next_command' };
}

function isExecutableProposal(proposal) {
  const nextCmd = normalizeText(proposal && proposal.suggested_next_command);
  const actionSpec = proposal && proposal.action_spec && typeof proposal.action_spec === 'object'
    ? proposal.action_spec
    : null;
  return !!(nextCmd || actionSpec);
}

function resolveObjectiveBinding(proposal, directiveObjectiveIds) {
  const p = proposal && typeof proposal === 'object' ? proposal : {};
  const meta = p.meta && typeof p.meta === 'object' ? p.meta : {};
  const actionSpec = p.action_spec && typeof p.action_spec === 'object' ? p.action_spec : {};
  const objectiveSet = new Set(Array.isArray(directiveObjectiveIds) ? directiveObjectiveIds : []);
  const executable = isExecutableProposal(p);
  const required = AUTONOMY_OBJECTIVE_BINDING_REQUIRED && executable && objectiveSet.size > 0;

  const directCandidates = [
    { source: 'meta.objective_id', value: meta.objective_id },
    { source: 'meta.directive_objective_id', value: meta.directive_objective_id },
    { source: 'action_spec.objective_id', value: actionSpec.objective_id },
    {
      source: 'meta.action_spec.objective_id',
      value: meta.action_spec && typeof meta.action_spec === 'object' ? meta.action_spec.objective_id : ''
    }
  ];

  let chosen = null;
  for (const row of directCandidates) {
    const id = sanitizeDirectiveObjectiveId(row && row.value);
    if (!id) continue;
    if (objectiveSet.size > 0 && !objectiveSet.has(id)) {
      chosen = { objective_id: id, source: row.source, valid: false };
      break;
    }
    chosen = { objective_id: id, source: row.source, valid: true };
    break;
  }

  if (!chosen) {
    const ev = parseObjectiveIdFromEvidence(p, objectiveSet);
    if (ev) chosen = { ...ev, valid: true };
  }
  if (!chosen) {
    const cmd = parseObjectiveIdFromCommand(p, objectiveSet);
    if (cmd) chosen = { ...cmd, valid: true };
  }
  if (!chosen && objectiveSet.size === 1) {
    const [only] = Array.from(objectiveSet);
    chosen = { objective_id: only, source: 'single_active_objective', valid: true };
  }

  const objectiveId = chosen ? String(chosen.objective_id || '') : '';
  const inObjectiveSet = objectiveId && objectiveSet.has(objectiveId);
  const bindingValid = objectiveId
    ? (objectiveSet.size === 0 ? true : (chosen.valid !== false && inObjectiveSet))
    : !required;

  let reason = 'not_required';
  if (required && !objectiveId) reason = 'missing_objective_binding';
  else if (required && !bindingValid) reason = 'invalid_objective_binding';
  else if (objectiveId && bindingValid) reason = 'objective_bound';

  return {
    objective_id: objectiveId || '',
    directive_objective_id: objectiveId || '',
    binding_required: required,
    binding_valid: bindingValid,
    binding_source: chosen ? String(chosen.source || '') : '',
    reason,
    active_objectives: Array.from(objectiveSet).slice(0, 8)
  };
}

function actionVerbFromText(text) {
  const m = normalizeText(text).match(ACTION_VERB_RE);
  return m ? String(m[1] || '').toLowerCase() : '';
}

function titleSansPrefix(title) {
  return normalizeText(title).replace(/^\[[^\]]+\]\s*/g, '');
}

function compactObjective(text, maxLen = 110) {
  const clean = normalizeText(text)
    .replace(/[;:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return '';
  if (clean.length <= maxLen) return clean;
  return clean.slice(0, maxLen).replace(/\s+\S*$/, '').trim();
}

function normalizedValidationMetric(proposal) {
  const validation = Array.isArray(proposal && proposal.validation) ? proposal.validation : [];
  if (validation.length) {
    const first = normalizeText(validation[0]).replace(/[.]+$/g, '');
    if (first) return first.slice(0, 120);
  }
  const cmd = normalizeText(proposal && proposal.suggested_next_command);
  if (cmd.includes('--dry-run')) return 'route dry-run completes with verifiable artifact';
  return 'proposal execution emits measurable artifact or outcome receipt';
}

function parseSuccessCriteriaRows(proposal) {
  const p = proposal && typeof proposal === 'object' ? proposal : {};
  const actionSpec = p.action_spec && typeof p.action_spec === 'object' ? p.action_spec : {};
  const actionRows = Array.isArray(actionSpec.success_criteria) ? actionSpec.success_criteria : [];
  const verifyRows = Array.isArray(actionSpec.verify) ? actionSpec.verify : [];
  const validationRows = Array.isArray(p.validation) ? p.validation : [];

  const rows = [];
  const pushText = (text, source) => {
    const clean = normalizeText(text);
    if (!clean) return;
    const metricMatch = clean.match(SUCCESS_METRIC_RE);
    const measurable = SUCCESS_METRIC_RE.test(clean) && (SUCCESS_TIMEBOUND_RE.test(clean) || /\d/.test(clean));
    rows.push({
      source,
      metric: metricMatch ? String(metricMatch[1] || '').toLowerCase() : '',
      target: clean.slice(0, 140),
      measurable
    });
  };

  for (const row of actionRows) {
    if (!row) continue;
    if (typeof row === 'string') {
      pushText(row, 'action_spec.success_criteria');
      continue;
    }
    if (typeof row === 'object') {
      const metric = normalizeText(row.metric || row.name || '');
      const target = normalizeText(row.target || row.threshold || row.description || row.goal || '');
      const horizon = normalizeText(row.horizon || row.window || row.by || '');
      const merged = normalizeText([metric, target, horizon].filter(Boolean).join(' | '));
      if (!merged) continue;
      rows.push({
        source: 'action_spec.success_criteria',
        metric: metric.toLowerCase(),
        target: merged.slice(0, 140),
        measurable: SUCCESS_METRIC_RE.test(merged) && (SUCCESS_TIMEBOUND_RE.test(merged) || /\d/.test(merged))
      });
    }
  }
  for (const row of verifyRows) pushText(row, 'action_spec.verify');
  for (const row of validationRows) pushText(row, 'validation');

  const dedupe = new Set();
  const out = [];
  for (const row of rows) {
    const key = `${row.metric}|${row.target}`.toLowerCase();
    if (dedupe.has(key)) continue;
    dedupe.add(key);
    out.push(row);
  }
  return out;
}

function successCriteriaRequirement(outcomePolicy) {
  const src = outcomePolicy && outcomePolicy.proposal_filter_policy && typeof outcomePolicy.proposal_filter_policy === 'object'
    ? outcomePolicy.proposal_filter_policy
    : {};
  const required = src.require_success_criteria !== false;
  const minCount = clamp(src.min_success_criteria_count, 0, 5, 1);
  return { required, min_count: minCount };
}

function inferArchetypeHints(text) {
  const hits = [];
  const hints = new Set();
  for (const rule of ARCHETYPE_RULES) {
    if (rule.regex.test(text)) {
      hits.push(rule.key);
      for (const h of rule.hints) hints.add(h);
    }
  }
  if (!hits.length) {
    hits.push('general');
    hints.add('systems');
    hints.add('automation');
  }
  return { archetypes: hits, hints: Array.from(hints).sort() };
}

function normalizeProposalForAdmission(proposal) {
  const p = proposal && typeof proposal === 'object' ? proposal : {};
  const meta = p.meta && typeof p.meta === 'object' ? p.meta : {};
  const title = titleSansPrefix(p.title);
  const combinedText = [
    title,
    p.type,
    p.summary,
    p.notes,
    p.expected_impact,
    p.suggested_next_command,
    Array.isArray(p.validation) ? p.validation.join(' ') : '',
    Array.isArray(p.evidence) ? p.evidence.map(ev => normalizeText(ev && ev.match)).join(' ') : ''
  ].join(' ');

  const { archetypes, hints } = inferArchetypeHints(combinedText);
  const actionVerb = actionVerbFromText(`${title} ${p.suggested_next_command || ''}`) || 'improve';
  const objectiveSeed = compactObjective(title) || compactObjective(`${p.type || 'proposal'} outcome quality`);
  const objective = compactObjective(`${actionVerb} ${objectiveSeed}`.replace(/\s+/g, ' ').trim(), 120);

  const expectedOutcome = normalizeText(meta.normalized_expected_outcome || '')
    || `Increase ${hints.slice(0, 2).join(' and ')} with measurable, low-risk execution.`;
  const validationMetric = normalizeText(meta.normalized_validation_metric || '')
    || normalizedValidationMetric(p);

  const summary = normalizeText(p.summary) || `${objective}. Outcome: ${expectedOutcome}`;
  const notes = normalizeText(p.notes)
    || `Objective=${objective}; Metric=${validationMetric}; Archetypes=${archetypes.join(',')}; Hints=${hints.join(',')}`;

  return {
    ...p,
    summary,
    notes,
    meta: {
      ...meta,
      normalized_action_verb: actionVerb,
      normalized_objective: objective,
      normalized_expected_outcome: expectedOutcome.slice(0, 180),
      normalized_validation_metric: validationMetric.slice(0, 140),
      normalized_archetypes: archetypes.slice(0, 5),
      normalized_hint_tokens: hints.slice(0, 8),
      normalization_version: '1.0'
    }
  };
}

function normalizedRisk(v) {
  const r = normalizeText(v).toLowerCase();
  if (r === 'high' || r === 'medium' || r === 'low') return r;
  return 'low';
}

function proposalTextBlob(proposal) {
  const p = proposal || {};
  const bits = [
    p.title,
    p.type,
    p.summary,
    p.notes,
    p.suggested_next_command
  ];
  if (Array.isArray(p.validation)) bits.push(p.validation.join(' '));
  if (Array.isArray(p.evidence)) {
    for (const ev of p.evidence) bits.push(ev && ev.match, ev && ev.evidence_ref);
  }
  const meta = p.meta && typeof p.meta === 'object' ? p.meta : {};
  bits.push(meta.preview, meta.url);
  bits.push(
    meta.normalized_objective,
    meta.normalized_expected_outcome,
    meta.normalized_validation_metric
  );
  if (Array.isArray(meta.normalized_hint_tokens)) bits.push(meta.normalized_hint_tokens.join(' '));
  if (Array.isArray(meta.normalized_archetypes)) bits.push(meta.normalized_archetypes.join(' '));
  if (Array.isArray(meta.topics)) bits.push(meta.topics.join(' '));
  return normalizeFitText(bits.filter(Boolean).join(' '));
}

function assessQuality(proposal, eye, t) {
  const p = proposal || {};
  let score = 20;
  const reasons = [];
  const impact = normalizeText(p.expected_impact).toLowerCase();
  const risk = normalizedRisk(p.risk);
  const title = normalizeText(p.title);
  const nextCmd = normalizeText(p.suggested_next_command);
  const validationCount = Array.isArray(p.validation) ? p.validation.length : 0;
  const evidenceCount = Array.isArray(p.evidence) ? p.evidence.length : 0;

  if (impact === 'high') score += 26;
  else if (impact === 'medium') score += 18;
  else score += 10;

  if (risk === 'high') score -= 16;
  else if (risk === 'medium') score -= 8;

  if (title.length >= 12) score += 6;
  if (title.length >= 28) score += 4;
  if (/\[stub\]/i.test(title)) {
    score -= 40;
    reasons.push('stub_title');
  }

  score += Math.min(16, validationCount * 4);
  score += Math.min(12, evidenceCount * 3);

  if (nextCmd) {
    score += 10;
    if (nextCmd.includes('--dry-run')) score += 4;
    if (nextCmd.startsWith('node ')) score += 3;
  } else {
    reasons.push('missing_next_command');
  }

  if (eye) {
    const eyeScore = Number(eye.score_ema);
    const eyeStatus = normalizeText(eye.status).toLowerCase();
    const parserType = normalizeText(eye.parser_type).toLowerCase();
    if (Number.isFinite(eyeScore)) {
      score += (eyeScore - 50) * 0.35;
      if (eyeScore < t.min_eye_score_ema) reasons.push('eye_score_ema_low');
    }
    if (eyeStatus === 'active') score += 4;
    else if (eyeStatus === 'probation') {
      score -= 6;
      reasons.push('eye_probation');
    } else if (eyeStatus === 'dormant') {
      score -= 20;
      reasons.push('eye_dormant');
    }
    if (parserType && DISALLOWED_PARSER_TYPES.has(parserType)) reasons.push(`parser_disallowed:${parserType}`);
  } else {
    reasons.push('eye_unknown');
  }

  return {
    score: clamp(Math.round(score), 0, 100),
    reasons: uniq(reasons)
  };
}

function tokenHits(tokens, tokenSet) {
  if (!tokenSet || !tokenSet.length) return [];
  const set = new Set(tokens);
  const stems = new Set(tokens.map(toStem));
  const out = [];
  for (const tok of tokenSet) {
    if (set.has(tok)) out.push(tok);
    else if (stems.has(toStem(tok))) out.push(tok);
  }
  return out;
}

function assessDirectiveFit(proposal, profile) {
  if (!profile || profile.available !== true) {
    return {
      score: 100,
      pass: true,
      matched_positive: [],
      matched_negative: [],
      reasons: ['directive_profile_unavailable']
    };
  }

  const blob = proposalTextBlob(proposal);
  const toks = tokenizeFitText(blob);
  const posPhraseHits = profile.positive_phrases.filter(ph => blob.includes(ph));
  const negPhraseHits = profile.negative_phrases.filter(ph => blob.includes(ph));
  const posTokenHits = tokenHits(toks, profile.positive_tokens);
  const negTokenHits = tokenHits(toks, profile.negative_tokens);
  const strategyTokens = Array.isArray(profile.strategy_tokens) ? profile.strategy_tokens : [];
  const strategyHits = tokenHits(toks, strategyTokens);

  let score = 30;
  score += posPhraseHits.length * 18;
  score += Math.min(28, posTokenHits.length * 5);
  score += Math.min(12, strategyHits.length * 4);
  score -= negPhraseHits.length * 20;
  score -= Math.min(24, negTokenHits.length * 6);

  const reasons = [];
  if (posPhraseHits.length === 0 && posTokenHits.length === 0 && strategyHits.length === 0) reasons.push('no_directive_alignment');
  if (strategyTokens.length > 0 && strategyHits.length === 0) reasons.push('no_strategy_marker');
  if (negPhraseHits.length > 0 || negTokenHits.length > 0) reasons.push('matches_excluded_scope');

  const finalScore = clamp(Math.round(score), 0, 100);
  return {
    score: finalScore,
    pass: finalScore >= thresholds().min_directive_fit,
    matched_positive: uniq([...posPhraseHits, ...posTokenHits, ...strategyHits]).slice(0, 5),
    matched_negative: uniq([...negPhraseHits, ...negTokenHits]).slice(0, 5),
    reasons: uniq(reasons)
  };
}

function assessActionability(proposal, directiveFitScore, relevanceScore, outcomePolicy) {
  const p = proposal || {};
  const risk = normalizedRisk(p.risk);
  const title = normalizeText(p.title).replace(/^\[[^\]]+\]\s*/g, '');
  const nextCmd = normalizeText(p.suggested_next_command);
  const validation = Array.isArray(p.validation) ? p.validation.map(v => normalizeText(v)).filter(Boolean) : [];
  const summary = normalizeText(p.summary);
  const evidenceText = Array.isArray(p.evidence)
    ? p.evidence.map(ev => normalizeText((ev && ev.match) || '')).join(' ')
    : '';
  const specificValidation = validation.filter(v => !GENERIC_VALIDATION_RE.test(v));
  const taskMatch = nextCmd.match(/--task=\"([^\"]+)\"/);
  const taskText = taskMatch ? normalizeText(taskMatch[1]) : '';
  const textBlob = normalizeFitText([title, summary, taskText, specificValidation.join(' '), evidenceText].join(' '));
  const hasActionVerb = ACTION_VERB_RE.test(title) || specificValidation.some(v => ACTION_VERB_RE.test(v));
  const hasOpportunity = OPPORTUNITY_MARKER_RE.test(textBlob);
  const hasConcreteTarget = CONCRETE_TARGET_RE.test(textBlob);
  const isMetaCoordination = META_COORDINATION_RE.test(textBlob);
  const isExplainer = EXPLAINER_TITLE_RE.test(title.toLowerCase());
  const genericRouteTask = GENERIC_ROUTE_TASK_RE.test(nextCmd);
  const criteriaRows = parseSuccessCriteriaRows(p);
  const measurableCriteriaCount = criteriaRows.filter((row) => row.measurable === true).length;
  const criteriaPolicy = successCriteriaRequirement(outcomePolicy);
  const isExecutableProposal = !!(nextCmd || (p.action_spec && typeof p.action_spec === 'object'));

  let score = 14;
  const reasons = [];

  if (hasActionVerb) score += 18;
  else reasons.push('no_action_verb');

  if (nextCmd) {
    if (genericRouteTask) {
      score += 4;
      reasons.push('generic_next_command_template');
    } else {
      score += 8;
      if (!nextCmd.includes('--dry-run')) score += 6;
      else score += 2;
    }
  }
  else reasons.push('missing_next_command');

  if (specificValidation.length >= 3) score += 18;
  else if (specificValidation.length >= 2) score += 12;
  else if (specificValidation.length >= 1) score += 6;
  else if (validation.length > 0) reasons.push('generic_validation_template');
  else reasons.push('missing_validation_plan');

  if (risk === 'low') score += 8;
  else if (risk === 'medium') score += 3;
  else score -= 8;

  score += clamp(Math.round((Number(relevanceScore || 0) - 35) * 0.4), 0, 20);
  score += clamp(Math.round((Number(directiveFitScore || 0) - 30) * 0.25), 0, 16);
  if (hasOpportunity) score += 10;

  if (isExecutableProposal && criteriaPolicy.required) {
    if (measurableCriteriaCount >= criteriaPolicy.min_count) {
      score += Math.min(14, 8 + (measurableCriteriaCount * 2));
    } else {
      score -= 22;
      reasons.push('success_criteria_missing');
    }
  } else if (measurableCriteriaCount > 0) {
    score += Math.min(8, measurableCriteriaCount * 2);
  }

  if (!hasActionVerb && !hasOpportunity && !hasConcreteTarget) {
    score -= 20;
    reasons.push('missing_concrete_target');
  }
  if (isMetaCoordination && !hasConcreteTarget) {
    score -= 26;
    reasons.push('meta_coordination_without_concrete_target');
  }
  if (/\bproposals?\b/.test(textBlob) && !hasConcreteTarget && !hasOpportunity) {
    score -= 12;
    reasons.push('proposal_recursion_without_target');
  }
  if (isExplainer && !hasActionVerb && !hasOpportunity) {
    score -= 12;
    reasons.push('explainer_without_execution_path');
  }
  if (genericRouteTask && specificValidation.length === 0 && !hasOpportunity && !hasConcreteTarget) {
    score -= 18;
    reasons.push('boilerplate_execution_path');
  }

  return {
    score: clamp(Math.round(score), 0, 100),
    reasons: uniq(reasons),
    success_criteria: {
      required: isExecutableProposal && criteriaPolicy.required,
      min_count: criteriaPolicy.min_count,
      measurable_count: measurableCriteriaCount,
      total_count: criteriaRows.length
    }
  };
}

function compositeScore(quality, directiveFit, actionability) {
  const q = clamp(Number(quality || 0), 0, 100);
  const d = clamp(Number(directiveFit || 0), 0, 100);
  const a = clamp(Number(actionability || 0), 0, 100);
  return clamp(Math.round((q * 0.42) + (d * 0.26) + (a * 0.32)), 0, 100);
}

function proposalRemediationDepth(p) {
  const meta = p && p.meta && typeof p.meta === 'object' ? p.meta : {};
  const raw = Number(meta.remediation_depth);
  if (Number.isFinite(raw) && raw >= 0) return Math.round(raw);
  const trigger = String(meta.trigger || '').toLowerCase();
  if (trigger === 'consecutive_failures' || trigger === 'multi_eye_transport_failure') return 1;
  return 0;
}

function admission(meta, eye, risk, t, proposal, strategy, outcomePolicy) {
  const reasons = [];
  const allowedRisks = effectiveAllowedRisksSet();
  const type = normalizeText(proposal && proposal.type).toLowerCase();
  const blob = proposalTextBlob(proposal);
  const hasOpportunity = OPPORTUNITY_MARKER_RE.test(blob);
  const hasConcreteTarget = CONCRETE_TARGET_RE.test(blob);
  const isMetaCoordination = META_COORDINATION_RE.test(blob);
  const criteriaPolicy = successCriteriaRequirement(outcomePolicy);
  const criteriaRequired = criteriaPolicy.required && !!(
    normalizeText(proposal && proposal.suggested_next_command)
    || (proposal && proposal.action_spec && typeof proposal.action_spec === 'object')
  );
  if (criteriaRequired) {
    const measured = Number(meta && meta.success_criteria_measurable_count || 0);
    if (measured < criteriaPolicy.min_count) reasons.push('success_criteria_missing');
  }
  if (!strategyAllowsProposalType(strategy, type)) reasons.push('strategy_type_filtered');
  const maxDepth = strategy
    && strategy.admission_policy
    && Number.isFinite(Number(strategy.admission_policy.max_remediation_depth))
      ? Number(strategy.admission_policy.max_remediation_depth)
      : null;
  if (Number.isFinite(maxDepth) && type.includes('remediation')) {
    const depth = proposalRemediationDepth(proposal);
    if (depth > maxDepth) reasons.push('strategy_remediation_depth_exceeded');
  }
  const parserType = normalizeText(eye && eye.parser_type).toLowerCase();
  if (parserType && DISALLOWED_PARSER_TYPES.has(parserType)) reasons.push(`parser_disallowed:${parserType}`);
  if (allowedRisks.size > 0 && !allowedRisks.has(risk)) reasons.push('risk_not_allowed');

  if (Number(meta.signal_quality_score) < t.min_sensory_signal_score) reasons.push('sensory_signal_low');
  if (Number(meta.relevance_score) < t.min_sensory_relevance_score) reasons.push('sensory_relevance_low');
  if (Number(meta.directive_fit_score) < t.min_directive_fit) reasons.push('directive_fit_low');
  if (Number(meta.actionability_score) < t.min_actionability_score) reasons.push('actionability_low');
  if (Number(meta.composite_eligibility_score) < t.min_composite_eligibility) reasons.push('composite_low');
  if (meta && meta.objective_binding_required === true) {
    const objectiveId = normalizeText(meta.objective_id || meta.directive_objective_id);
    if (!objectiveId) reasons.push('objective_binding_missing');
    else if (meta.objective_binding_valid === false) reasons.push('objective_binding_invalid');
  }
  if (isMetaCoordination && !hasConcreteTarget) reasons.push('meta_proposal_non_actionable');
  if (/\bproposals?\b/.test(blob) && !hasConcreteTarget && !hasOpportunity) reasons.push('proposal_recursion_non_actionable');

  return {
    eligible: reasons.length === 0,
    blocked_by: reasons
  };
}

function enrichOne(proposal, ctx) {
  const raw = proposal && typeof proposal === 'object' ? proposal : {};
  const p = normalizeProposalForAdmission(raw);
  const srcEye = sourceEyeId(p);
  const eye = ctx.eyes.get(srcEye) || null;
  const risk = normalizedRisk(p.risk);
  const t = ctx.thresholds;
  const objectiveBinding = resolveObjectiveBinding(p, ctx.directiveObjectiveIds);

  const q = assessQuality(p, eye, t);
  const d = assessDirectiveFit(p, ctx.directiveProfile);
  const relevance = clamp(Math.round((q.score * 0.55) + (d.score * 0.45)), 0, 100);
  const a = assessActionability(p, d.score, relevance, ctx.outcomePolicy);
  const comp = compositeScore(q.score, d.score, a.score);
  const strategy = ctx.strategy || null;
  const admit = admission({
    signal_quality_score: q.score,
    relevance_score: relevance,
    directive_fit_score: d.score,
    actionability_score: a.score,
    composite_eligibility_score: comp,
    success_criteria_measurable_count: a.success_criteria ? Number(a.success_criteria.measurable_count || 0) : 0,
    success_criteria_total_count: a.success_criteria ? Number(a.success_criteria.total_count || 0) : 0,
    objective_id: objectiveBinding.objective_id || '',
    directive_objective_id: objectiveBinding.directive_objective_id || '',
    objective_binding_required: objectiveBinding.binding_required === true,
    objective_binding_valid: objectiveBinding.binding_valid !== false
  }, eye, risk, t, p, strategy, ctx.outcomePolicy);

  const prevMeta = raw.meta && typeof raw.meta === 'object' ? raw.meta : {};
  const nextMeta = {
    ...prevMeta,
    ...(p.meta && typeof p.meta === 'object' ? p.meta : {}),
    source_eye: srcEye,
    objective_id: objectiveBinding.objective_id || null,
    directive_objective_id: objectiveBinding.directive_objective_id || null,
    objective_binding_required: objectiveBinding.binding_required === true,
    objective_binding_valid: objectiveBinding.binding_valid !== false,
    objective_binding_source: objectiveBinding.binding_source || null,
    objective_binding_reason: objectiveBinding.reason || null,
    active_directive_objectives: objectiveBinding.active_objectives,
    signal_quality_score: q.score,
    signal_quality_tier: tier(q.score),
    relevance_score: relevance,
    relevance_tier: tier(relevance),
    directive_fit_score: d.score,
    directive_fit_pass: d.score >= t.min_directive_fit,
    directive_fit_positive: d.matched_positive,
    directive_fit_negative: d.matched_negative,
    relevance_reasons: uniq([...q.reasons, ...d.reasons]).slice(0, 8),
    actionability_score: a.score,
    actionability_pass: a.score >= t.min_actionability_score,
    actionability_reasons: a.reasons.slice(0, 6),
    success_criteria_required: a.success_criteria && a.success_criteria.required === true,
    success_criteria_min_count: a.success_criteria ? Number(a.success_criteria.min_count || 0) : 0,
    success_criteria_measurable_count: a.success_criteria ? Number(a.success_criteria.measurable_count || 0) : 0,
    success_criteria_total_count: a.success_criteria ? Number(a.success_criteria.total_count || 0) : 0,
    composite_eligibility_score: comp,
    composite_eligibility_pass: comp >= t.min_composite_eligibility,
    admission_preview: {
      eligible: admit.eligible,
      blocked_by: admit.blocked_by.slice(0, 6)
    },
    enriched_at: nowIso(),
    enrichment_version: '1.2'
  };

  const next = {
    ...p,
    risk,
    meta: nextMeta
  };

  const changed = JSON.stringify(prevMeta) !== JSON.stringify(nextMeta) || String(p.risk || '') !== risk;
  return {
    proposal: next,
    changed,
    admission: admit
  };
}

function summarizeAdmissions(results) {
  let eligible = 0;
  let blocked = 0;
  const blockedByReason = {};
  for (const r of results) {
    const a = r && r.admission ? r.admission : { eligible: false, blocked_by: ['unknown'] };
    if (a.eligible) eligible += 1;
    else {
      blocked += 1;
      const reasons = Array.isArray(a.blocked_by) && a.blocked_by.length ? a.blocked_by : ['unknown'];
      for (const reason of reasons) blockedByReason[reason] = Number(blockedByReason[reason] || 0) + 1;
    }
  }
  return {
    total: results.length,
    eligible,
    blocked,
    blocked_by_reason: Object.fromEntries(Object.entries(blockedByReason).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])))
  };
}

function parseDateOrToday(v) {
  return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : todayStr();
}

function runForDate(dateStr, dryRun = false) {
  const loaded = loadProposalsForDate(dateStr);
  if (!loaded.exists) {
    return {
      ok: true,
      result: 'no_proposals_file',
      date: dateStr,
      path: loaded.filePath,
      changed: 0,
      admission: { total: 0, eligible: 0, blocked: 0, blocked_by_reason: {} }
    };
  }

  const directiveProfile = loadDirectiveProfile();
  const ctx = {
    eyes: loadEyesMap(),
    directiveProfile,
    directiveObjectiveIds: activeDirectiveObjectiveIds(directiveProfile),
    strategy: strategyProfile(),
    thresholds: thresholds(),
    outcomePolicy: loadOutcomeFitnessPolicy(ROOT)
  };

  const out = [];
  let changed = 0;
  for (const p of loaded.proposals) {
    const r = enrichOne(p, ctx);
    if (r.changed) changed += 1;
    out.push(r);
  }

  const proposalsOut = out.map(x => x.proposal);
  if (!dryRun && changed > 0) {
    saveProposalsForDate(loaded.filePath, loaded.container, proposalsOut);
  }

  const admissionSummary = summarizeAdmissions(out);
  return {
    ok: true,
    result: dryRun ? 'dry_run' : 'enriched',
    date: dateStr,
    path: loaded.filePath,
    changed,
    total: loaded.proposals.length,
    directive_profile_available: ctx.directiveProfile.available === true,
    strategy_profile: ctx.strategy
      ? {
          id: ctx.strategy.id,
          name: ctx.strategy.name,
          status: ctx.strategy.status,
          file: path.relative(ROOT, ctx.strategy.file).replace(/\\/g, '/'),
          execution_mode: ctx.strategy.execution_policy && ctx.strategy.execution_policy.mode
            ? String(ctx.strategy.execution_policy.mode)
            : null,
          allowed_risks: Array.isArray(ctx.strategy.risk_policy && ctx.strategy.risk_policy.allowed_risks)
            ? ctx.strategy.risk_policy.allowed_risks
            : [],
          threshold_overrides: ctx.strategy.threshold_overrides || {},
          validation: ctx.strategy.validation || { strict_ok: true, errors: [], warnings: [] }
        }
      : null,
    thresholds: ctx.thresholds,
    admission: admissionSummary
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] || '';
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd !== 'run') {
    usage();
    process.exit(2);
  }
  const dateStr = parseDateOrToday(args._[1]);
  const dryRun = args['dry-run'] === true;
  const out = runForDate(dateStr, dryRun);
  process.stdout.write(JSON.stringify(out) + '\n');
}

if (require.main === module) main();

module.exports = {
  runForDate,
  enrichOne,
  summarizeAdmissions
};
