#!/usr/bin/env node
'use strict';

/**
 * focus_controller.js
 *
 * Sensory scan->focus controller.
 * - Refreshes adaptive focus triggers from current priorities
 * - Scores scan items and escalates a bounded subset to focus mode
 * - Optional lightweight URL expansion for focused items
 *
 * Usage:
 *   node systems/sensory/focus_controller.js refresh [YYYY-MM-DD]
 *   node systems/sensory/focus_controller.js status
 *   node systems/sensory/focus_controller.js --help
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { loadActiveDirectives } = require('../../lib/directive_resolver.js');
const { loadActiveStrategy } = require('../../lib/strategy_resolver.js');
const { loadOutcomeFitnessPolicy } = require('../../lib/outcome_fitness.js');
const { ensureCatalog } = require('../../lib/eyes_catalog.js');
const { egressFetch, EgressGatewayError } = require('../../lib/egress_gateway.js');
const {
  DEFAULT_STATE_DIR: GLOBAL_BUDGET_STATE_DIR,
  DEFAULT_EVENTS_PATH: GLOBAL_BUDGET_EVENTS_PATH,
  DEFAULT_AUTOPAUSE_PATH: GLOBAL_BUDGET_AUTOPAUSE_PATH,
  loadSystemBudgetState,
  projectSystemBudget,
  recordSystemBudgetUsage,
  writeSystemBudgetDecision,
  loadSystemBudgetAutopauseState,
  setSystemBudgetAutopause,
  evaluateSystemBudgetGuard
} = require('../budget/system_budget.js');
const {
  ensureFocusState,
  mutateFocusState
} = require('../adaptive/sensory/eyes/focus_trigger_store.js');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SENSORY_DIR = process.env.FOCUS_SENSORY_DIR
  ? path.resolve(process.env.FOCUS_SENSORY_DIR)
  : path.join(REPO_ROOT, 'state', 'sensory');
const PROPOSALS_DIR = path.join(SENSORY_DIR, 'proposals');
const ANOMALIES_DIR = path.join(SENSORY_DIR, 'anomalies');
const EYES_STATE_DIR = process.env.EYES_STATE_DIR
  ? path.resolve(process.env.EYES_STATE_DIR)
  : path.join(REPO_ROOT, 'state', 'sensory', 'eyes');
const EYES_REGISTRY_PATH = path.join(EYES_STATE_DIR, 'registry.json');
const EYES_RAW_DIR = path.join(EYES_STATE_DIR, 'raw');
const EYES_CATALOG_PATH = path.join(REPO_ROOT, 'adaptive', 'sensory', 'eyes', 'catalog.json');
const CROSS_SIGNAL_HYPOTHESES_DIR = path.join(SENSORY_DIR, 'cross_signal', 'hypotheses');
const FOCUS_BUDGET_ENABLED = String(process.env.FOCUS_BUDGET_ENABLED || '1') !== '0';
const FOCUS_BUDGET_TOKENS_PER_FETCH = clamp(process.env.FOCUS_BUDGET_TOKENS_PER_FETCH || 35, 1, 2000, 35);
const FOCUS_BUDGET_MODULE = String(process.env.FOCUS_BUDGET_MODULE || 'sensory_focus').trim() || 'sensory_focus';
const FOCUS_BUDGET_STATE_DIR = process.env.FOCUS_BUDGET_STATE_DIR
  ? path.resolve(process.env.FOCUS_BUDGET_STATE_DIR)
  : GLOBAL_BUDGET_STATE_DIR;
const FOCUS_BUDGET_EVENTS_PATH = process.env.FOCUS_BUDGET_EVENTS_PATH
  ? path.resolve(process.env.FOCUS_BUDGET_EVENTS_PATH)
  : GLOBAL_BUDGET_EVENTS_PATH;
const FOCUS_BUDGET_AUTOPAUSE_PATH = process.env.FOCUS_BUDGET_AUTOPAUSE_PATH
  ? path.resolve(process.env.FOCUS_BUDGET_AUTOPAUSE_PATH)
  : GLOBAL_BUDGET_AUTOPAUSE_PATH;
const FOCUS_BUDGET_PREVIEW_BYPASS_AUTOPAUSE = String(process.env.FOCUS_BUDGET_PREVIEW_BYPASS_AUTOPAUSE || '1') !== '0';

const TOKEN_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'into', 'through', 'that', 'this', 'those', 'these', 'your', 'you',
  'their', 'our', 'are', 'was', 'were', 'been', 'being', 'have', 'has', 'had', 'will', 'would', 'should',
  'could', 'must', 'can', 'not', 'all', 'any', 'only', 'each', 'per', 'but', 'its', 'it', 'as', 'at', 'on',
  'to', 'in', 'of', 'or', 'an', 'a', 'by', 'new', 'latest', 'today', 'week', 'month'
]);

function nowIso() {
  return new Date().toISOString();
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/sensory/focus_controller.js refresh [YYYY-MM-DD]');
  console.log('  node systems/sensory/focus_controller.js status');
  console.log('  node systems/sensory/focus_controller.js --help');
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

function clamp(n, lo, hi, fallback) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  if (x < lo) return lo;
  if (x > hi) return hi;
  return x;
}

function normalizeText(v) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
}

function normalizeKey(v) {
  return normalizeText(v)
    .toLowerCase()
    .replace(/[^a-z0-9:_ -]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(v) {
  const s = normalizeKey(v);
  if (!s) return [];
  return s
    .split(' ')
    .filter(Boolean)
    .filter((t) => t.length >= 3)
    .filter((t) => !TOKEN_STOPWORDS.has(t))
    .filter((t) => !/^\d+$/.test(t));
}

function uniq(arr) {
  return Array.from(new Set(arr));
}

function sha16(v) {
  return crypto.createHash('sha256').update(String(v || ''), 'utf8').digest('hex').slice(0, 16);
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
  const out = [];
  try {
    if (!fs.existsSync(filePath)) return out;
    const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      try { out.push(JSON.parse(line)); } catch {}
    }
  } catch {
    return out;
  }
  return out;
}

function dateToMs(dateStr) {
  return Date.parse(`${dateStr}T00:00:00.000Z`);
}

function datesInWindow(windowDays, endDateStr) {
  const out = [];
  const endMs = dateToMs(endDateStr);
  for (let i = windowDays - 1; i >= 0; i--) {
    const ms = endMs - (i * 24 * 60 * 60 * 1000);
    out.push(new Date(ms).toISOString().slice(0, 10));
  }
  return out;
}

function safeHoursSince(ts) {
  const ms = Date.parse(String(ts || ''));
  if (!Number.isFinite(ms)) return null;
  return (Date.now() - ms) / (1000 * 60 * 60);
}

function termMatched(term, text, tokenSet) {
  const t = normalizeKey(term);
  if (!t) return false;
  if (tokenSet.has(t)) return true;
  const space = t.replace(/_/g, ' ');
  return text.includes(t) || text.includes(space);
}

function loadProposals(dateStr) {
  const fp = path.join(PROPOSALS_DIR, `${dateStr}.json`);
  const raw = readJsonSafe(fp, []);
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object' && Array.isArray(raw.proposals)) return raw.proposals;
  return [];
}

function collectStrategySignals() {
  let strategy = null;
  try {
    strategy = loadActiveStrategy({ allowMissing: true });
  } catch {
    strategy = null;
  }
  if (!strategy) return [];
  const objective = strategy.objective && typeof strategy.objective === 'object' ? strategy.objective : {};
  return [
    normalizeText(strategy.id),
    normalizeText(strategy.name),
    normalizeText(objective.primary),
    normalizeText(objective.fitness_metric),
    ...(Array.isArray(objective.secondary) ? objective.secondary.map(normalizeText) : []),
    ...(Array.isArray(strategy.tags) ? strategy.tags.map(normalizeText) : [])
  ].filter(Boolean);
}

function collectDirectiveSignals() {
  let directives = [];
  try {
    directives = loadActiveDirectives({ allowMissing: true, allowWeakTier1: true });
  } catch {
    directives = [];
  }
  const out = [];
  for (const d of directives || []) {
    if (!d || typeof d !== 'object') continue;
    const data = d.data && typeof d.data === 'object' ? d.data : {};
    const meta = data.metadata && typeof data.metadata === 'object' ? data.metadata : {};
    const intent = data.intent && typeof data.intent === 'object' ? data.intent : {};
    const scope = data.scope && typeof data.scope === 'object' ? data.scope : {};
    const success = data.success_metrics && typeof data.success_metrics === 'object' ? data.success_metrics : {};
    out.push(normalizeText(d.id));
    out.push(normalizeText(meta.description));
    out.push(normalizeText(intent.primary));
    if (Array.isArray(scope.included)) out.push(...scope.included.map(normalizeText));
    if (Array.isArray(success.leading)) out.push(...success.leading.map(normalizeText));
    if (Array.isArray(success.lagging)) out.push(...success.lagging.map(normalizeText));
  }
  return out.filter(Boolean);
}

function collectProposalSignals(dateStr) {
  const rows = loadProposals(dateStr);
  const out = [];
  for (const p of rows) {
    if (!p || typeof p !== 'object') continue;
    if (String(p.status || '').toLowerCase() === 'resolved') continue;
    out.push(normalizeText(p.title));
    out.push(normalizeText(p.summary));
    const meta = p.meta && typeof p.meta === 'object' ? p.meta : {};
    out.push(normalizeText(meta.normalized_objective));
    out.push(normalizeText(meta.normalized_expected_outcome));
    if (Array.isArray(meta.normalized_hint_tokens)) out.push(meta.normalized_hint_tokens.join(' '));
    if (Array.isArray(meta.topics)) out.push(meta.topics.join(' '));
  }
  return out.filter(Boolean);
}

function collectAnomalySignals(dateStr) {
  if (!fs.existsSync(ANOMALIES_DIR)) return [];
  const files = fs.readdirSync(ANOMALIES_DIR).filter((f) => f.startsWith(`${dateStr}.`) && f.endsWith('.json'));
  const out = [];
  for (const f of files) {
    const payload = readJsonSafe(path.join(ANOMALIES_DIR, f), {});
    if (!payload || typeof payload !== 'object') continue;
    if (Array.isArray(payload.anomalies)) {
      for (const a of payload.anomalies) {
        out.push(normalizeText(a && a.type));
        out.push(normalizeText(a && a.message));
      }
    }
  }
  return out.filter(Boolean);
}

function collectTopEyeTopicSignals() {
  const catalog = ensureCatalog(EYES_CATALOG_PATH);
  const registry = readJsonSafe(EYES_REGISTRY_PATH, {});
  const regMap = new Map();
  for (const e of (Array.isArray(registry && registry.eyes) ? registry.eyes : [])) {
    if (!e || !e.id) continue;
    regMap.set(String(e.id), e);
  }
  const rows = [];
  for (const eye of (Array.isArray(catalog && catalog.eyes) ? catalog.eyes : [])) {
    if (!eye || !eye.id) continue;
    const reg = regMap.get(String(eye.id)) || {};
    const score = Number(reg.score_ema != null ? reg.score_ema : eye.score_ema);
    const topics = Array.isArray(eye.topics) ? eye.topics : [];
    rows.push({
      id: String(eye.id),
      score: Number.isFinite(score) ? score : 0,
      topics: topics.map(normalizeText).filter(Boolean).slice(0, 8)
    });
  }
  rows.sort((a, b) => b.score - a.score);
  const out = [];
  for (const row of rows.slice(0, 6)) {
    out.push(...row.topics);
  }
  return out.filter(Boolean);
}

function weightedTokenMap(signalGroups) {
  const map = new Map();
  for (const g of signalGroups) {
    if (!g || !Array.isArray(g.texts)) continue;
    const weight = clamp(g.weight, 1, 100, 1);
    for (const text of g.texts) {
      for (const tok of tokenize(text)) {
        const prev = map.get(tok) || { weight: 0, source_signals: new Set() };
        prev.weight += weight;
        prev.source_signals.add(String(g.name || 'unknown'));
        map.set(tok, prev);
      }
    }
  }
  return map;
}

function toTriggerCandidates(signalGroups, maxCount) {
  const weighted = weightedTokenMap(signalGroups);
  const rows = [];
  for (const [token, v] of weighted.entries()) {
    rows.push({
      key: `token:${token}`,
      pattern: token,
      mode: 'contains',
      source: 'auto',
      source_signals: Array.from(v.source_signals).sort(),
      weight: clamp(Math.round(v.weight), 1, 100, 1),
      cooldown_minutes: 90,
      status: 'active'
    });
  }
  rows.sort((a, b) => {
    if (b.weight !== a.weight) return b.weight - a.weight;
    return String(a.key).localeCompare(String(b.key));
  });
  return rows.slice(0, Math.max(8, Math.min(200, Number(maxCount) || 48)));
}

function mergeAutoTriggers(current, next, nowTs) {
  const keep = [];
  const currentAuto = new Map();
  for (const t of current || []) {
    if (!t || typeof t !== 'object') continue;
    if (String(t.source || '').toLowerCase() === 'manual') {
      keep.push({ ...t, updated_ts: nowTs });
      continue;
    }
    currentAuto.set(String(t.key || ''), { ...t });
  }

  const merged = [];
  const used = new Set();
  for (const row of next) {
    const key = String(row.key || '');
    if (!key) continue;
    const prev = currentAuto.get(key);
    const prevWeight = Number(prev && prev.weight || 0);
    const nextWeight = Number(row.weight || 0);
    merged.push({
      ...(prev || {}),
      ...row,
      weight: clamp(Math.round((prevWeight * 0.35) + (nextWeight * 0.65)), 1, 100, 1),
      created_ts: prev && prev.created_ts ? prev.created_ts : nowTs,
      updated_ts: nowTs
    });
    used.add(key);
  }

  for (const [key, prev] of currentAuto.entries()) {
    if (used.has(key)) continue;
    const decayed = clamp(Math.round(Number(prev.weight || 0) * 0.85), 0, 100, 0);
    if (decayed < 3) continue;
    merged.push({
      ...prev,
      weight: decayed,
      updated_ts: nowTs
    });
  }

  return [...keep, ...merged];
}

function mapAdd(map, key, delta) {
  const k = normalizeKey(key);
  if (!k) return;
  const prev = Number(map.get(k) || 0);
  map.set(k, prev + Number(delta || 0));
}

function collectCatalogEyeTopics() {
  const catalog = ensureCatalog(EYES_CATALOG_PATH);
  const out = new Map();
  for (const eye of (Array.isArray(catalog && catalog.eyes) ? catalog.eyes : [])) {
    if (!eye || !eye.id) continue;
    const eyeId = normalizeKey(eye.id);
    if (!eyeId) continue;
    const row = out.get(eyeId) || [];
    const topics = Array.isArray(eye.topics) ? eye.topics : [];
    for (const t of topics) {
      const tok = normalizeKey(t);
      if (!tok) continue;
      row.push(tok);
    }
    out.set(eyeId, uniq(row).slice(0, 24));
  }
  return out;
}

function collectRecentEyeSignals(dateStr, windowDays) {
  const dates = datesInWindow(windowDays, dateStr);
  const byEye = new Map();
  let eventCount = 0;
  for (const d of dates) {
    const fp = path.join(EYES_RAW_DIR, `${d}.jsonl`);
    const events = readJsonlSafe(fp);
    for (const e of events) {
      if (!e || e.type !== 'external_item') continue;
      const eyeId = normalizeKey(e.eye_id);
      if (!eyeId) continue;
      const title = normalizeText(e.title);
      if (title.toUpperCase().includes('[STUB]')) continue;
      eventCount += 1;
      const row = byEye.get(eyeId) || {
        include_scores: new Map(),
        exclude_scores: new Map(),
        focused_items: 0,
        seen_items: 0
      };
      row.seen_items += 1;
      const terms = [];
      const topics = Array.isArray(e.topics) ? e.topics : [];
      for (const t of topics) terms.push(normalizeKey(t));
      terms.push(...tokenize(title).map(normalizeKey));
      const triggerHits = Array.isArray(e.focus_trigger_hits) ? e.focus_trigger_hits : [];
      for (const h of triggerHits) terms.push(normalizeKey(h));
      const uniqTerms = uniq(terms.filter(Boolean)).slice(0, 16);
      const focusMode = String(e.focus_mode || 'scan').toLowerCase();
      const focusScore = Number(e.focus_score || 0);
      let bump = 1;
      if (focusMode === 'focus') {
        row.focused_items += 1;
        bump += 3;
      }
      if (focusScore >= 70) bump += 2;
      for (const term of uniqTerms) mapAdd(row.include_scores, term, bump);
      if (focusMode !== 'focus' && focusScore > 0 && focusScore <= 20) {
        for (const term of uniqTerms) mapAdd(row.exclude_scores, term, 1);
      }
      byEye.set(eyeId, row);
    }
  }
  return { byEye, event_count: eventCount, window_days: windowDays };
}

function eyeIdsFromCrossSignalHypothesis(hyp) {
  const out = [];
  const evidence = Array.isArray(hyp && hyp.evidence) ? hyp.evidence : [];
  for (const e of evidence) {
    const eyeId = normalizeKey(e && e.eye_id);
    if (eyeId) out.push(eyeId);
  }
  const active = Array.isArray(hyp && hyp.active_eyes) ? hyp.active_eyes : [];
  for (const a of active) {
    const eyeId = normalizeKey(a && typeof a === 'object' ? a.eye_id : a);
    if (eyeId) out.push(eyeId);
  }
  const absent = Array.isArray(hyp && hyp.absent_eyes) ? hyp.absent_eyes : [];
  for (const a of absent) {
    const eyeId = normalizeKey(a && typeof a === 'object' ? a.eye_id : a);
    if (eyeId) out.push(eyeId);
  }
  const leader = normalizeKey(hyp && hyp.leader_eye);
  if (leader) out.push(leader);
  const follower = normalizeKey(hyp && hyp.follower_eye);
  if (follower) out.push(follower);
  return uniq(out);
}

function collectCrossSignalEyeSignals(dateStr, windowDays, boost) {
  const dates = datesInWindow(windowDays, dateStr);
  const byEye = new Map();
  let hypothesisCount = 0;
  for (const d of dates) {
    const fp = path.join(CROSS_SIGNAL_HYPOTHESES_DIR, `${d}.json`);
    const raw = readJsonSafe(fp, {});
    const hypotheses = Array.isArray(raw && raw.hypotheses) ? raw.hypotheses : (Array.isArray(raw) ? raw : []);
    for (const h of hypotheses) {
      const confidence = Number(h && h.confidence || 0);
      if (confidence < 45) continue;
      const topic = normalizeKey(h && h.topic);
      if (!topic) continue;
      const eyeIds = eyeIdsFromCrossSignalHypothesis(h);
      if (!eyeIds.length) continue;
      hypothesisCount += 1;
      const delta = Number(boost || 0) + clamp(Math.round(confidence / 25), 1, 4, 1);
      for (const eyeId of eyeIds) {
        const row = byEye.get(eyeId) || new Map();
        mapAdd(row, topic, delta);
        byEye.set(eyeId, row);
      }
    }
  }
  return { byEye, hypothesis_count: hypothesisCount, window_days: windowDays };
}

function maybeRefreshEyeLenses(dateStr, force = false) {
  const state = ensureFocusState(null, {
    source: 'systems/sensory/focus_controller.js',
    reason: 'ensure_lens_state'
  });
  const policy = state.policy || {};
  if (policy.lens_enabled === false) {
    return { ok: true, refreshed: false, enabled: false, reason: 'lens_disabled', lens_count: Object.keys(state.eye_lenses || {}).length };
  }

  const refreshHours = clamp(policy.lens_refresh_hours, 1, 72, 6);
  const lastMs = Date.parse(String(state.last_lens_refresh_ts || ''));
  const due = !Number.isFinite(lastMs) || ((Date.now() - lastMs) >= (refreshHours * 60 * 60 * 1000));
  if (!force && !due) {
    return {
      ok: true,
      refreshed: false,
      enabled: true,
      due: false,
      refresh_hours: refreshHours,
      last_lens_refresh_ts: state.last_lens_refresh_ts || null,
      lens_count: Object.keys(state.eye_lenses || {}).length
    };
  }

  const maxTerms = clamp(policy.lens_max_terms, 4, 64, 16);
  const maxExclude = clamp(policy.lens_max_exclude_terms, 0, 32, 6);
  const minWeight = clamp(policy.lens_min_weight, 1, 40, 2);
  const maxWeight = clamp(policy.lens_max_weight, 1, 60, 20);
  const minSupport = clamp(policy.lens_min_support, 1, 20, 2);
  const decay = clamp(policy.lens_decay, 0.5, 0.99, 0.9);
  const excludeThreshold = clamp(policy.lens_exclude_threshold, 1, 50, 4);
  const crossBoost = clamp(policy.lens_cross_signal_boost, 0, 20, 3);
  const windowDays = Math.max(1, Math.ceil(clamp(policy.lens_window_hours, 6, 24 * 14, 48) / 24));
  const recent = collectRecentEyeSignals(dateStr, windowDays);
  const cross = collectCrossSignalEyeSignals(dateStr, windowDays, crossBoost);
  const catalogTopics = collectCatalogEyeTopics();
  const nowTs = nowIso();

  const nextState = mutateFocusState(
    null,
    (current) => {
      const next = { ...current };
      const currentLenses = current.eye_lenses && typeof current.eye_lenses === 'object' ? current.eye_lenses : {};
      const out = {};
      const eyeIds = new Set([
        ...Object.keys(currentLenses),
        ...Array.from(catalogTopics.keys()),
        ...Array.from(recent.byEye.keys()),
        ...Array.from(cross.byEye.keys())
      ]);

      for (const rawEyeId of eyeIds) {
        const eyeId = normalizeKey(rawEyeId);
        if (!eyeId) continue;
        const prev = currentLenses[eyeId] && typeof currentLenses[eyeId] === 'object'
          ? currentLenses[eyeId]
          : { include_terms: [], exclude_terms: [], term_weights: {}, baseline_topics: [], focus_hits_total: 0, update_count: 0 };
        const includeScores = new Map();
        for (const term of (Array.isArray(prev.include_terms) ? prev.include_terms : [])) {
          const w = Number(prev.term_weights && prev.term_weights[term] || minWeight);
          mapAdd(includeScores, term, w * decay);
        }
        const baseline = catalogTopics.get(eyeId) || [];
        for (const term of baseline) mapAdd(includeScores, term, minWeight + 1);
        const recentRow = recent.byEye.get(eyeId);
        if (recentRow && recentRow.include_scores instanceof Map) {
          for (const [term, w] of recentRow.include_scores.entries()) mapAdd(includeScores, term, w);
        }
        const crossRow = cross.byEye.get(eyeId);
        if (crossRow instanceof Map) {
          for (const [term, w] of crossRow.entries()) mapAdd(includeScores, term, w);
        }

        const includeTerms = Array.from(includeScores.entries())
          .filter(([, w]) => Number(w) >= Math.max(minWeight, minSupport))
          .sort((a, b) => Number(b[1]) - Number(a[1]))
          .map(([term]) => normalizeKey(term))
          .filter(Boolean)
          .slice(0, maxTerms);

        const termWeights = {};
        for (const term of includeTerms) {
          termWeights[term] = clamp(Math.round(Number(includeScores.get(term) || minWeight)), minWeight, maxWeight, minWeight);
        }

        const excludeScores = new Map();
        for (const term of (Array.isArray(prev.exclude_terms) ? prev.exclude_terms : [])) {
          mapAdd(excludeScores, term, 1 * decay);
        }
        if (recentRow && recentRow.exclude_scores instanceof Map) {
          for (const [term, w] of recentRow.exclude_scores.entries()) mapAdd(excludeScores, term, w);
        }
        const excludeTerms = Array.from(excludeScores.entries())
          .filter(([term, w]) => Number(w) >= excludeThreshold && !includeTerms.includes(term))
          .sort((a, b) => Number(b[1]) - Number(a[1]))
          .map(([term]) => normalizeKey(term))
          .filter(Boolean)
          .slice(0, maxExclude);

        out[eyeId] = {
          eye_id: eyeId,
          include_terms: includeTerms,
          exclude_terms: excludeTerms,
          term_weights: termWeights,
          baseline_topics: uniq(baseline).slice(0, maxTerms),
          focus_hits_total: Number(prev.focus_hits_total || 0) + Number(recentRow && recentRow.focused_items || 0),
          update_count: Number(prev.update_count || 0) + 1,
          created_ts: prev.created_ts || nowTs,
          updated_ts: nowTs
        };
      }

      next.eye_lenses = out;
      next.last_lens_refresh_ts = nowTs;
      next.last_lens_refresh_sources = {
        recent_event_count: Number(recent.event_count || 0),
        recent_window_days: Number(recent.window_days || windowDays),
        cross_signal_hypotheses: Number(cross.hypothesis_count || 0),
        cross_signal_window_days: Number(cross.window_days || windowDays),
        catalog_eyes: Number(catalogTopics.size || 0)
      };
      next.stats = {
        ...(next.stats || {}),
        lens_refresh_count: Number((next.stats && next.stats.lens_refresh_count) || 0) + 1
      };
      return next;
    },
    {
      source: 'systems/sensory/focus_controller.js',
      reason: 'refresh_eye_lenses'
    }
  );

  return {
    ok: true,
    refreshed: true,
    enabled: true,
    refresh_hours: refreshHours,
    lens_count: Object.keys(nextState.eye_lenses || {}).length,
    last_lens_refresh_ts: nextState.last_lens_refresh_ts || null,
    source_summary: nextState.last_lens_refresh_sources || {}
  };
}

function maybeRefreshFocusTriggers(opts = {}) {
  const dateStr = /^\d{4}-\d{2}-\d{2}$/.test(String(opts.dateStr || ''))
    ? String(opts.dateStr)
    : todayStr();
  const nowTs = nowIso();
  const force = opts.force === true;
  const lensRefresh = maybeRefreshEyeLenses(dateStr, force);
  const focusState = ensureFocusState(null, {
    source: 'systems/sensory/focus_controller.js',
    reason: 'ensure_focus_state'
  });
  const refreshHours = Number(focusState.policy && focusState.policy.refresh_hours || 4);
  const lastMs = Date.parse(String(focusState.last_refresh_ts || ''));
  const due = !Number.isFinite(lastMs) || ((Date.now() - lastMs) >= (refreshHours * 60 * 60 * 1000));
  if (!force && !due) {
    return {
      ok: true,
      refreshed: false,
      due: false,
      refresh_hours: refreshHours,
      last_refresh_ts: focusState.last_refresh_ts || null,
      trigger_count: Array.isArray(focusState.triggers) ? focusState.triggers.length : 0,
      lens_refresh: lensRefresh
    };
  }

  const groups = [
    { name: 'strategy', weight: 9, texts: collectStrategySignals() },
    { name: 'directives', weight: 8, texts: collectDirectiveSignals() },
    { name: 'proposals', weight: 6, texts: collectProposalSignals(dateStr) },
    { name: 'anomalies', weight: 6, texts: collectAnomalySignals(dateStr) },
    { name: 'top_eyes', weight: 4, texts: collectTopEyeTopicSignals() }
  ];
  const candidateTriggers = toTriggerCandidates(groups, focusState.policy && focusState.policy.max_triggers);
  const sourceSummary = {};
  for (const g of groups) {
    sourceSummary[String(g.name)] = Number((Array.isArray(g.texts) ? g.texts.length : 0));
  }

  const nextState = mutateFocusState(
    null,
    (state) => {
      const next = { ...state };
      const maxTriggers = Number(next.policy && next.policy.max_triggers || 48);
      next.triggers = mergeAutoTriggers(next.triggers, candidateTriggers, nowTs)
        .sort((a, b) => {
          if (Number(b.weight || 0) !== Number(a.weight || 0)) return Number(b.weight || 0) - Number(a.weight || 0);
          return String(a.key || '').localeCompare(String(b.key || ''));
        })
        .slice(0, Math.max(8, Math.min(200, maxTriggers)));
      next.last_refresh_ts = nowTs;
      next.last_refresh_sources = sourceSummary;
      next.stats = {
        ...(next.stats || {}),
        refresh_count: Number((next.stats && next.stats.refresh_count) || 0) + 1
      };
      return next;
    },
    {
      source: 'systems/sensory/focus_controller.js',
      reason: String(opts.reason || 'periodic_refresh').slice(0, 120)
    }
  );

  return {
    ok: true,
    refreshed: true,
    date: dateStr,
    trigger_count: Array.isArray(nextState.triggers) ? nextState.triggers.length : 0,
    source_summary: sourceSummary,
    refresh_hours: refreshHours,
    last_refresh_ts: nextState.last_refresh_ts,
    lens_refresh: lensRefresh
  };
}

function normalizeItemFingerprint(item) {
  const id = normalizeText(item && (item.id || item.item_hash));
  if (id) return `id:${id.toLowerCase()}`;
  const url = normalizeText(item && item.url);
  if (url) return `url:${sha16(url.toLowerCase())}`;
  return `raw:${sha16(JSON.stringify(item || {}))}`;
}

function itemTextBlob(item) {
  const bits = [
    normalizeText(item && item.title),
    normalizeText(item && item.description),
    normalizeText(item && item.content_preview),
    normalizeText(item && item.summary),
    normalizeText(item && item.url)
  ];
  if (Array.isArray(item && item.topics)) bits.push(item.topics.map(normalizeText).join(' '));
  if (Array.isArray(item && item.tags)) bits.push(item.tags.map(normalizeText).join(' '));
  return normalizeKey(bits.filter(Boolean).join(' '));
}

function scoreFocus(item, state, eyeLens = null) {
  const policy = state && state.policy ? state.policy : {};
  const text = itemTextBlob(item);
  const tokenSet = new Set(tokenize(text));
  const hits = [];
  const lensHits = [];
  const lensExcludeHits = [];
  let lensDelta = 0;
  let score = 0;
  const title = normalizeText(item && item.title);
  const topics = Array.isArray(item && item.topics) ? item.topics : [];
  const hasUrl = /^https?:\/\//i.test(normalizeText(item && item.url));
  const fallbackLike = (() => {
    const tags = Array.isArray(item && item.tags) ? item.tags : [];
    if (item && item.fallback === true) return true;
    if (String(title || '').toUpperCase().includes('[STUB]')) return true;
    if (String(title || '').toLowerCase().includes('fallback')) return true;
    return tags.some((t) => String(t || '').toLowerCase() === 'fallback');
  })();

  if (hasUrl) score += 4;
  if (title.length >= 24) score += 5;
  if (topics.length >= 1) score += 4;
  if (topics.length >= 3) score += 4;
  if (fallbackLike) score -= 16;

  for (const t of (Array.isArray(state && state.triggers) ? state.triggers : [])) {
    if (!t || String(t.status || 'active') !== 'active') continue;
    const key = String(t.pattern || '').toLowerCase().trim();
    if (!key) continue;
    let matched = false;
    if (String(t.mode || 'contains') === 'exact') {
      matched = tokenSet.has(key);
    } else {
      matched = tokenSet.has(key) || text.includes(key);
    }
    if (!matched) continue;
    const weight = clamp(t.weight, 1, 100, 1);
    score += Math.min(28, Math.max(2, Math.round(weight / 2)));
    hits.push(key);
  }

  if (eyeLens && typeof eyeLens === 'object') {
    const includeTerms = Array.isArray(eyeLens.include_terms) ? eyeLens.include_terms : [];
    const excludeTerms = Array.isArray(eyeLens.exclude_terms) ? eyeLens.exclude_terms : [];
    const termWeights = eyeLens.term_weights && typeof eyeLens.term_weights === 'object' ? eyeLens.term_weights : {};
    for (const term of includeTerms) {
      if (!termMatched(term, text, tokenSet)) continue;
      const weight = clamp(termWeights[term], 1, 40, 2);
      const delta = Math.min(12, Math.max(1, Math.round(weight / 2)));
      score += delta;
      lensDelta += delta;
      lensHits.push(term);
    }
    for (const term of excludeTerms) {
      if (!termMatched(term, text, tokenSet)) continue;
      const delta = 6;
      score -= delta;
      lensDelta -= delta;
      lensExcludeHits.push(term);
    }
  }

  if (item && item.signal === true) score += 12;
  if (Number.isFinite(Number(item && item.value_score))) {
    score += clamp(Number(item.value_score), 0, 15, 0);
  }
  if (/critical|outage|incident|exploit|leak|security/.test(text)) score += 8;
  if (/launch|release|version|roadmap|hiring|funding/.test(text)) score += 5;

  const fp = normalizeItemFingerprint(item);
  const recent = state && state.recent_focus_items && state.recent_focus_items[fp]
    ? Date.parse(String(state.recent_focus_items[fp]))
    : NaN;
  const dedupeWindowMs = clamp(policy.dedupe_window_hours, 1, 14 * 24, 36) * 60 * 60 * 1000;
  if (Number.isFinite(recent) && (Date.now() - recent) < dedupeWindowMs) {
    score -= 25;
  }

  return {
    score: clamp(Math.round(score), 0, 100, 0),
    hits: uniq(hits).slice(0, 8),
    lens_hits: uniq(lensHits).slice(0, 8),
    lens_exclude_hits: uniq(lensExcludeHits).slice(0, 8),
    lens_delta: Number(lensDelta || 0),
    fingerprint: fp
  };
}

function countRecentFocusInWindow(recentMap, windowHours, nowMs = Date.now()) {
  const src = recentMap && typeof recentMap === 'object' ? recentMap : {};
  const cutoff = Number(nowMs) - (Number(windowHours) * 60 * 60 * 1000);
  let count = 0;
  for (const tsRaw of Object.values(src)) {
    const ts = Date.parse(String(tsRaw || ''));
    if (!Number.isFinite(ts)) continue;
    if (ts >= cutoff) count++;
  }
  return count;
}

function resolveMinFocusScore(policy, recentMap, nowMs = Date.now(), outcomePolicy = null) {
  const fitnessDelta = Number(
    outcomePolicy
      && outcomePolicy.focus_policy
      && outcomePolicy.focus_policy.min_focus_score_delta
  ) || 0;
  const baseRaw = clamp(policy && policy.min_focus_score, 1, 100, 58);
  const base = clamp(baseRaw + fitnessDelta, 1, 100, baseRaw);
  const enabled = policy && policy.dynamic_focus_gate_enabled === false ? false : true;
  const windowHours = clamp(policy && policy.dynamic_focus_window_hours, 1, 72, 6);
  const targetPerWindow = clamp(policy && policy.dynamic_focus_target_per_window, 0, 500, 8);
  const response = clamp(policy && policy.dynamic_focus_response, 0, 60, 14);
  const floorRaw = clamp(policy && policy.dynamic_focus_floor_score, 1, 100, 24);
  const ceilingRaw = clamp(policy && policy.dynamic_focus_ceiling_score, 1, 100, 85);
  const floorScore = Math.min(floorRaw, ceilingRaw);
  const ceilingScore = Math.max(floorRaw, ceilingRaw);
  const recentCount = countRecentFocusInWindow(recentMap, windowHours, nowMs);
  let effective = base;
  let delta = 0;
  if (enabled && response > 0) {
    const denom = Math.max(1, targetPerWindow);
    const pressure = (recentCount - targetPerWindow) / denom;
    delta = Math.round(pressure * response);
    effective = clamp(base + delta, floorScore, ceilingScore, base);
  }
  return {
    enabled,
    fitness_delta: fitnessDelta,
    base,
    effective,
    delta,
    recent_count: recentCount,
    window_hours: windowHours,
    target_per_window: targetPerWindow,
    response,
    floor_score: floorScore,
    ceiling_score: ceilingScore
  };
}

function resolveOutcomeTuning(outcomePolicy) {
  const realized = clamp(
    outcomePolicy && outcomePolicy.realized_outcome_score,
    0,
    100,
    50
  );
  if (realized < 45) {
    return {
      realized_score: realized,
      lens_step_up_delta: -1,
      lens_step_down_delta: 1,
      prune_budget_multiplier: 1.5,
      prune_stale_scale: 0.7
    };
  }
  if (realized > 70) {
    return {
      realized_score: realized,
      lens_step_up_delta: 1,
      lens_step_down_delta: 0,
      prune_budget_multiplier: 0.6,
      prune_stale_scale: 1.2
    };
  }
  return {
    realized_score: realized,
    lens_step_up_delta: 0,
    lens_step_down_delta: 0,
    prune_budget_multiplier: 1,
    prune_stale_scale: 1
  };
}

function triggerPriorityScore(trigger, nowMs = Date.now()) {
  const t = trigger && typeof trigger === 'object' ? trigger : {};
  const weight = clamp(t.weight, 1, 100, 1);
  const hits = clamp(t.hit_count, 0, 100000000, 0);
  const seenTs = Date.parse(String(t.last_hit_ts || t.updated_ts || t.created_ts || ''));
  const ageHours = Number.isFinite(seenTs) ? Math.max(0, (nowMs - seenTs) / (1000 * 60 * 60)) : 9999;
  const recency = ageHours <= 24 ? (24 - ageHours) / 6 : 0;
  return (weight * 0.7) + (Math.log10(hits + 1) * 8) + recency;
}

function pruneFocusTriggerRows(rows, policy, outcomePolicy, nowMs = Date.now()) {
  const src = Array.isArray(rows) ? rows.map((row) => ({ ...(row || {}) })) : [];
  const pol = policy && typeof policy === 'object' ? policy : {};
  if (pol.trigger_prune_enabled === false) {
    return { triggers: src, pruned: 0, forced_pruned: 0 };
  }
  const tuning = resolveOutcomeTuning(outcomePolicy);
  const maxTriggers = clamp(pol.max_triggers, 8, 200, 48);
  const minHitCount = clamp(pol.trigger_prune_min_hit_count, 0, 1000, 1);
  const keepRatio = clamp(pol.trigger_prune_keep_ratio, 0.1, 1, 0.6);
  const keepFloor = Math.max(8, Math.floor(maxTriggers * keepRatio));
  const pruneLimit = Math.max(
    1,
    Math.floor(clamp(pol.trigger_prune_max_per_run, 1, 200, 8) * clamp(tuning.prune_budget_multiplier, 0.4, 2.5, 1))
  );
  const staleHours = Math.max(
    6,
    Math.floor(clamp(pol.trigger_prune_stale_hours, 6, 24 * 30, 72) * clamp(tuning.prune_stale_scale, 0.5, 2, 1))
  );

  const survivors = [];
  const pruneCandidates = [];
  for (const row of src) {
    const source = normalizeText(row && row.source).toLowerCase();
    if (source === 'manual') {
      survivors.push(row);
      continue;
    }
    const seenTs = Date.parse(String(row && (row.last_hit_ts || row.updated_ts || row.created_ts) || ''));
    const ageHours = Number.isFinite(seenTs) ? Math.max(0, (nowMs - seenTs) / (1000 * 60 * 60)) : Infinity;
    const hitCount = Number(row && row.hit_count || 0);
    const stale = ageHours >= staleHours;
    if (stale && hitCount <= minHitCount) {
      pruneCandidates.push({ row, ageHours, priority: triggerPriorityScore(row, nowMs) });
    } else {
      survivors.push(row);
    }
  }
  pruneCandidates.sort((a, b) => {
    if (b.ageHours !== a.ageHours) return b.ageHours - a.ageHours;
    if (a.priority !== b.priority) return a.priority - b.priority;
    return String(a.row && a.row.key || '').localeCompare(String(b.row && b.row.key || ''));
  });

  let pruned = 0;
  for (const cand of pruneCandidates) {
    if (pruned >= pruneLimit) {
      survivors.push(cand.row);
      continue;
    }
    if (survivors.length <= keepFloor) {
      survivors.push(cand.row);
      continue;
    }
    pruned += 1;
  }

  survivors.sort((a, b) => {
    const sa = triggerPriorityScore(a, nowMs);
    const sb = triggerPriorityScore(b, nowMs);
    if (sb !== sa) return sb - sa;
    return String(a && a.key || '').localeCompare(String(b && b.key || ''));
  });
  let forcedPruned = 0;
  if (survivors.length > maxTriggers) {
    forcedPruned = survivors.length - maxTriggers;
  }
  const limited = survivors.slice(0, maxTriggers);
  return {
    triggers: limited,
    pruned,
    forced_pruned: forcedPruned
  };
}

function extractTitle(html) {
  const m = String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? normalizeText(m[1].replace(/\s+/g, ' ')).slice(0, 180) : '';
}

function extractDescription(html) {
  const src = String(html || '');
  const m = src.match(/<meta[^>]+name=['"]description['"][^>]+content=['"]([^'"]+)['"]/i)
    || src.match(/<meta[^>]+content=['"]([^'"]+)['"][^>]+name=['"]description['"]/i)
    || src.match(/<meta[^>]+property=['"]og:description['"][^>]+content=['"]([^'"]+)['"]/i);
  return m ? normalizeText(m[1]).slice(0, 240) : '';
}

async function fetchFocusDetails(item, policy) {
  if (String(process.env.FOCUS_FETCH_ENABLED || '1') === '0') return null;
  if (!policy || policy.expand_fetch_enabled === false) return null;
  const url = normalizeText(item && item.url);
  if (!url) return null;
  if (!/^https?:\/\//i.test(url)) return null;
  const timeoutMs = clamp(policy.focus_fetch_timeout_ms, 500, 15000, 4500);
  const maxBytes = clamp(policy.focus_fetch_max_bytes, 4096, 1048576, 131072);
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const host = new URL(url).hostname;
    const res = await egressFetch(url, {
      method: 'GET',
      headers: { 'User-Agent': 'openclaw-focus/1.0' },
      signal: controller.signal
    }, {
      scope: 'sensory.focus_fetch',
      caller: 'systems/sensory/focus_controller',
      runtime_allowlist: [host],
      timeout_ms: timeoutMs,
      meta: {
        eye_id: String(item && item.eye_id || '').slice(0, 120),
        item_id: String(item && item.id || '').slice(0, 120)
      }
    });
    const ct = String(res.headers.get('content-type') || '').toLowerCase();
    const lenHeader = Number(res.headers.get('content-length'));
    if (Number.isFinite(lenHeader) && lenHeader > maxBytes * 2) {
      return {
        fetched: false,
        status: Number(res.status || 0),
        reason: 'content_too_large'
      };
    }
    const body = await res.text();
    const trimmed = String(body || '').slice(0, maxBytes);
    if (ct.includes('application/json')) {
      return {
        fetched: true,
        status: Number(res.status || 0),
        content_type: ct,
        title: '',
        description: normalizeText(trimmed).slice(0, 240)
      };
    }
    return {
      fetched: true,
      status: Number(res.status || 0),
      content_type: ct,
      title: extractTitle(trimmed),
      description: extractDescription(trimmed)
    };
  } catch (err) {
    if (err instanceof EgressGatewayError) {
      return {
        fetched: false,
        reason: `egress_denied:${String(err.details && err.details.code || 'policy').slice(0, 40)}`
      };
    }
    return {
      fetched: false,
      reason: String(err && err.name ? err.name : err || 'fetch_failed').slice(0, 80)
    };
  } finally {
    clearTimeout(t);
  }
}

function evaluateFocusBudget(dateStr, selectedCount) {
  const autonomyEnabled = String(process.env.AUTONOMY_ENABLED || '0') === '1';
  const requestedCount = Math.max(0, Math.round(Number(selectedCount || 0)));
  const tokensPerFetch = Math.max(1, Math.round(Number(FOCUS_BUDGET_TOKENS_PER_FETCH || 35)));
  if (!FOCUS_BUDGET_ENABLED || requestedCount <= 0) {
    return {
      enabled: FOCUS_BUDGET_ENABLED,
      decision: 'allow',
      reason: FOCUS_BUDGET_ENABLED ? null : 'focus_budget_disabled',
      requested_count: requestedCount,
      allowed_count: requestedCount,
      request_tokens_est: requestedCount * tokensPerFetch,
      tokens_per_fetch: tokensPerFetch,
      projection: null
    };
  }

  const requestTokens = requestedCount * tokensPerFetch;
  const budgetAutopause = loadSystemBudgetAutopauseState({
    autopause_path: FOCUS_BUDGET_AUTOPAUSE_PATH
  });
  const autopauseReason = String(budgetAutopause.reason || '').trim();
  const previewBypassAutopause = !autonomyEnabled
    && FOCUS_BUDGET_PREVIEW_BYPASS_AUTOPAUSE
    && autopauseReason === 'burn_rate_exceeded';
  if (budgetAutopause.active === true) {
    if (previewBypassAutopause) {
      writeSystemBudgetDecision({
        date: dateStr,
        module: FOCUS_BUDGET_MODULE,
        capability: 'focus_fetch',
        request_tokens_est: requestTokens,
        decision: 'allow',
        reason: 'preview_bypass_burn_rate_autopause'
      }, {
        state_dir: FOCUS_BUDGET_STATE_DIR,
        events_path: FOCUS_BUDGET_EVENTS_PATH,
        soft_ratio: 0.75,
        hard_ratio: 0.92
      });
      return {
        enabled: true,
        decision: 'allow',
        reason: 'preview_bypass_burn_rate_autopause',
        requested_count: requestedCount,
        allowed_count: requestedCount,
        request_tokens_est: requestTokens,
        tokens_per_fetch: tokensPerFetch,
        projection: null,
        budget_autopause: {
          active: true,
          source: budgetAutopause.source || null,
          reason: budgetAutopause.reason || null,
          until: budgetAutopause.until || null
        },
        budget_guard: null
      };
    }
    writeSystemBudgetDecision({
      date: dateStr,
      module: FOCUS_BUDGET_MODULE,
      capability: 'focus_fetch',
      request_tokens_est: requestTokens,
      decision: 'deny',
      reason: 'budget_autopause_active'
    }, {
      state_dir: FOCUS_BUDGET_STATE_DIR,
      events_path: FOCUS_BUDGET_EVENTS_PATH,
      soft_ratio: 0.75,
      hard_ratio: 0.92
    });
    return {
      enabled: true,
      decision: 'deny',
      reason: 'budget_autopause_active',
      requested_count: requestedCount,
      allowed_count: 0,
      request_tokens_est: requestTokens,
      tokens_per_fetch: tokensPerFetch,
      projection: null,
      budget_autopause: {
        active: true,
        source: budgetAutopause.source || null,
        reason: budgetAutopause.reason || null,
        until: budgetAutopause.until || null
      },
      budget_guard: null
    };
  }

  const budgetGuard = evaluateSystemBudgetGuard({
    date: dateStr,
    request_tokens_est: requestTokens
  }, {
    state_dir: FOCUS_BUDGET_STATE_DIR,
    events_path: FOCUS_BUDGET_EVENTS_PATH,
    autopause_path: FOCUS_BUDGET_AUTOPAUSE_PATH
  });
  if (budgetGuard.hard_stop === true) {
    const hardReason = String((budgetGuard.hard_stop_reasons && budgetGuard.hard_stop_reasons[0]) || 'budget_guard_hard_stop');
    const previewBypassHardStop = !autonomyEnabled
      && FOCUS_BUDGET_PREVIEW_BYPASS_AUTOPAUSE
      && hardReason === 'burn_rate_exceeded';
    if (previewBypassHardStop) {
      writeSystemBudgetDecision({
        date: dateStr,
        module: FOCUS_BUDGET_MODULE,
        capability: 'focus_fetch',
        request_tokens_est: requestTokens,
        decision: 'allow',
        reason: 'preview_bypass_burn_rate_hard_stop'
      }, {
        state_dir: FOCUS_BUDGET_STATE_DIR,
        events_path: FOCUS_BUDGET_EVENTS_PATH,
        soft_ratio: 0.75,
        hard_ratio: 0.92
      });
      return {
        enabled: true,
        decision: 'allow',
        reason: 'preview_bypass_burn_rate_hard_stop',
        requested_count: requestedCount,
        allowed_count: requestedCount,
        request_tokens_est: requestTokens,
        tokens_per_fetch: tokensPerFetch,
        projection: null,
        budget_autopause: {
          active: false,
          source: budgetAutopause.source || null,
          reason: budgetAutopause.reason || null,
          until: budgetAutopause.until || null
        },
        budget_guard: budgetGuard
      };
    }
    writeSystemBudgetDecision({
      date: dateStr,
      module: FOCUS_BUDGET_MODULE,
      capability: 'focus_fetch',
      request_tokens_est: requestTokens,
      decision: 'deny',
      reason: hardReason
    }, {
      state_dir: FOCUS_BUDGET_STATE_DIR,
      events_path: FOCUS_BUDGET_EVENTS_PATH,
      soft_ratio: 0.75,
      hard_ratio: 0.92
    });
    setSystemBudgetAutopause({
      source: 'focus_controller',
      reason: hardReason,
      pressure: 'hard',
      date: dateStr,
      minutes: 60
    }, {
      autopause_path: FOCUS_BUDGET_AUTOPAUSE_PATH
    });
    return {
      enabled: true,
      decision: 'deny',
      reason: hardReason,
      requested_count: requestedCount,
      allowed_count: 0,
      request_tokens_est: requestTokens,
      tokens_per_fetch: tokensPerFetch,
      projection: null,
      budget_autopause: {
        active: false,
        source: budgetAutopause.source || null,
        reason: budgetAutopause.reason || null,
        until: budgetAutopause.until || null
      },
      budget_guard: budgetGuard
    };
  }

  const state = loadSystemBudgetState(dateStr, {
    state_dir: FOCUS_BUDGET_STATE_DIR
  });
  const projection = projectSystemBudget(state, requestTokens, {
    soft_ratio: 0.75,
    hard_ratio: 0.92
  });
  const cap = Number(state && state.token_cap);
  const used = Number(state && state.used_est);
  const validCap = Number.isFinite(cap) && cap > 0 && Number.isFinite(used) && used >= 0;
  const availableTokens = validCap ? Math.max(0, cap - used) : requestTokens;
  const allowedCount = Math.max(
    0,
    Math.min(
      requestedCount,
      Math.floor(availableTokens / tokensPerFetch)
    )
  );
  const decision = allowedCount <= 0
    ? 'deny'
    : (allowedCount < requestedCount ? 'degrade' : 'allow');
  const reason = decision === 'deny'
    ? 'focus_budget_cap_exceeded'
    : (decision === 'degrade' ? 'focus_budget_pressure' : null);

  writeSystemBudgetDecision({
    date: dateStr,
    module: FOCUS_BUDGET_MODULE,
    capability: 'focus_fetch',
    request_tokens_est: requestTokens,
    decision,
    reason
  }, {
    state_dir: FOCUS_BUDGET_STATE_DIR,
    events_path: FOCUS_BUDGET_EVENTS_PATH,
    soft_ratio: 0.75,
    hard_ratio: 0.92
  });

  return {
    enabled: true,
    decision,
    reason,
    requested_count: requestedCount,
    allowed_count: allowedCount,
    request_tokens_est: requestTokens,
    tokens_per_fetch: tokensPerFetch,
    projection,
    budget_autopause: {
      active: false,
      source: budgetAutopause.source || null,
      reason: budgetAutopause.reason || null,
      until: budgetAutopause.until || null
    },
    budget_guard: budgetGuard,
    state: {
      token_cap: Number.isFinite(cap) ? cap : null,
      used_est: Number.isFinite(used) ? used : null
    }
  };
}

async function evaluateFocusForEye(opts = {}) {
  const eye = opts.eye && typeof opts.eye === 'object' ? opts.eye : {};
  const eyeId = String(eye.id || '');
  const eyeKey = normalizeKey(eyeId);
  const dateStr = /^\d{4}-\d{2}-\d{2}$/.test(String(opts.dateStr || ''))
    ? String(opts.dateStr)
    : todayStr();
  const items = Array.isArray(opts.items) ? opts.items.slice() : [];
  const state = ensureFocusState(null, {
    source: 'systems/sensory/focus_controller.js',
    reason: 'evaluate_focus'
  });
  const policy = state.policy || {};
  const outcomePolicy = loadOutcomeFitnessPolicy(REPO_ROOT);
  const gate = resolveMinFocusScore(policy, state.recent_focus_items, Date.now(), outcomePolicy);
  const minScore = gate.effective;
  const perEyeCap = clamp(
    opts.maxFocusPerEye != null ? opts.maxFocusPerEye : policy.max_focus_items_per_eye,
    1,
    20,
    2
  );
  const perRunRemaining = clamp(
    opts.remainingRunBudget != null ? opts.remainingRunBudget : policy.max_focus_items_per_run,
    0,
    100,
    policy.max_focus_items_per_run
  );
  const selectCap = Math.max(0, Math.min(perEyeCap, perRunRemaining));
  const eyeLens = eyeKey && state.eye_lenses && typeof state.eye_lenses === 'object'
    ? (state.eye_lenses[eyeKey] || null)
    : null;

  const scored = items.map((item, idx) => {
    const s = scoreFocus(item, state, eyeLens);
    return { idx, item, ...s };
  });
  const selected = scored
    .filter((x) => x.score >= minScore && (x.hits.length > 0 || x.lens_hits.length > 0))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return String(a.item && a.item.id || '').localeCompare(String(b.item && b.item.id || ''));
    })
    .slice(0, selectCap);

  if (selected.length === 0 && selectCap > 0) {
    const fallbackMin = Math.max(12, Math.round(minScore * 0.45));
    const fallbackSelected = scored
      .filter((x) => x.score >= fallbackMin)
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return String(a.item && a.item.id || '').localeCompare(String(b.item && b.item.id || ''));
      })
      .slice(0, Math.min(1, selectCap));
    for (const row of fallbackSelected) selected.push(row);
  }

  const selectedByIndex = new Map();
  const focusEvents = [];
  const focusBudget = evaluateFocusBudget(dateStr, selected.length);
  const detailFetchCap = focusBudget.enabled === true
    ? Math.max(0, Number(focusBudget.allowed_count || 0))
    : selected.length;
  let detailFetchUsed = 0;
  for (let i = 0; i < selected.length; i++) {
    const row = selected[i];
    let detail = null;
    let detailSkippedReason = null;
    if (i < detailFetchCap) {
      detail = await fetchFocusDetails(row.item, policy);
      detailFetchUsed += 1;
    } else {
      detailSkippedReason = String(focusBudget.reason || 'focus_budget_denied');
    }
    const enriched = {
      ...(row.item || {}),
      focus_mode: 'focus',
      focus_score: row.score,
      focus_trigger_hits: row.hits.slice(0, 8),
      focus_lens_hits: row.lens_hits.slice(0, 8),
      focus_lens_exclude_hits: row.lens_exclude_hits.slice(0, 8),
      focus_lens_delta: Number(row.lens_delta || 0),
      focus_details: detail,
      focus_detail_skipped_reason: detailSkippedReason
    };
    selectedByIndex.set(row.idx, enriched);
    focusEvents.push({
      ts: nowIso(),
      type: 'eye_focus_selected',
      date: dateStr,
      eye_id: String(eye.id || ''),
      parser_type: String(eye.parser_type || ''),
      item_hash: String(row.item && (row.item.id || row.item.item_hash) || ''),
      url: normalizeText(row.item && row.item.url),
      focus_score: row.score,
      trigger_hits: row.hits.slice(0, 8),
      lens_hits: row.lens_hits.slice(0, 8),
      lens_exclude_hits: row.lens_exclude_hits.slice(0, 8),
      lens_delta: Number(row.lens_delta || 0),
      detail_fetched: !!(detail && detail.fetched === true),
      detail_skipped_reason: detailSkippedReason
    });
  }

  if (FOCUS_BUDGET_ENABLED && detailFetchUsed > 0) {
    recordSystemBudgetUsage({
      date: dateStr,
      module: FOCUS_BUDGET_MODULE,
      capability: 'focus_fetch',
      tokens_est: detailFetchUsed * Math.max(1, Number(focusBudget.tokens_per_fetch || FOCUS_BUDGET_TOKENS_PER_FETCH))
    }, {
      state_dir: FOCUS_BUDGET_STATE_DIR,
      events_path: FOCUS_BUDGET_EVENTS_PATH
    });
  }

  const outputItems = scored.map((row) => {
    const focused = selectedByIndex.get(row.idx);
    if (focused) return focused;
    return {
      ...(row.item || {}),
      focus_mode: 'scan',
      focus_score: row.score,
      focus_trigger_hits: row.hits.slice(0, 8),
      focus_lens_hits: row.lens_hits.slice(0, 8),
      focus_lens_exclude_hits: row.lens_exclude_hits.slice(0, 8),
      focus_lens_delta: Number(row.lens_delta || 0)
    };
  });

  if (selected.length > 0) {
    mutateFocusState(
      null,
      (current) => {
        const next = { ...current };
        const recent = { ...(next.recent_focus_items || {}) };
        const triggerMap = new Map(
          (Array.isArray(next.triggers) ? next.triggers : []).map((t) => [String(t.key || ''), { ...t }])
        );
        const lensMap = next.eye_lenses && typeof next.eye_lenses === 'object'
          ? { ...(next.eye_lenses || {}) }
          : {};
        const lens = eyeKey && lensMap[eyeKey] && typeof lensMap[eyeKey] === 'object'
          ? {
            ...lensMap[eyeKey],
            term_weights: { ...((lensMap[eyeKey] && lensMap[eyeKey].term_weights) || {}) }
          }
          : null;
        const ts = nowIso();
        const tuning = resolveOutcomeTuning(outcomePolicy);
        const lensStepUp = clamp(
          clamp(next.policy && next.policy.lens_step_up, 1, 10, 2) + Number(tuning.lens_step_up_delta || 0),
          1,
          10,
          2
        );
        const lensStepDown = clamp(
          clamp(next.policy && next.policy.lens_step_down, 1, 10, 1) + Number(tuning.lens_step_down_delta || 0),
          1,
          10,
          1
        );
        const lensMinWeight = clamp(next.policy && next.policy.lens_min_weight, 1, 40, 2);
        const lensMaxWeight = clamp(next.policy && next.policy.lens_max_weight, 1, 60, 20);
        for (const row of selected) {
          recent[row.fingerprint] = ts;
          for (const hit of row.hits) {
            const key = `token:${hit}`;
            const trig = triggerMap.get(key);
            if (!trig) continue;
            trig.hit_count = Number(trig.hit_count || 0) + 1;
            trig.last_hit_ts = ts;
            trig.updated_ts = ts;
            triggerMap.set(key, trig);
          }
          if (lens) {
            lens.focus_hits_total = Number(lens.focus_hits_total || 0) + 1;
            for (const term of (Array.isArray(row.lens_hits) ? row.lens_hits : [])) {
              const prev = Number(lens.term_weights && lens.term_weights[term] || lensMinWeight);
              lens.term_weights[term] = clamp(prev + lensStepUp, lensMinWeight, lensMaxWeight, lensMinWeight);
            }
            for (const term of (Array.isArray(row.lens_exclude_hits) ? row.lens_exclude_hits : [])) {
              const prev = Number(lens.term_weights && lens.term_weights[term] || lensMinWeight);
              lens.term_weights[term] = clamp(prev - lensStepDown, lensMinWeight, lensMaxWeight, lensMinWeight);
            }
          }
        }
        next.recent_focus_items = recent;
        const triggerRows = Array.from(triggerMap.values());
        const pruned = pruneFocusTriggerRows(triggerRows, next.policy || {}, outcomePolicy, Date.now());
        next.triggers = pruned.triggers;
        if (lens && eyeKey) {
          lens.updated_ts = ts;
          lens.update_count = Number(lens.update_count || 0) + 1;
          lensMap[eyeKey] = lens;
          next.eye_lenses = lensMap;
        }
        next.stats = {
          ...(next.stats || {}),
          focused_items_total: Number((next.stats && next.stats.focused_items_total) || 0) + selected.length,
          trigger_pruned_total: Number((next.stats && next.stats.trigger_pruned_total) || 0)
            + Number(pruned.pruned || 0)
            + Number(pruned.forced_pruned || 0),
          last_trigger_prune_ts: ts,
          last_focus_ts: ts
        };
        return next;
      },
      {
        source: 'systems/sensory/focus_controller.js',
        reason: 'focus_hits'
      }
    );
  }

  return {
    ok: true,
    eye_id: eyeId,
    date: dateStr,
    min_focus_score: minScore,
    min_focus_score_base: gate.base,
    dynamic_focus_gate: gate,
    selected_count: selected.length,
    detail_fetch_used: detailFetchUsed,
    focus_budget: focusBudget,
    outcome_tuning: resolveOutcomeTuning(outcomePolicy),
    selected_fingerprints: selected.map((x) => x.fingerprint),
    items: outputItems,
    focus_events: focusEvents
  };
}

function focusStatus() {
  const state = ensureFocusState(null, {
    source: 'systems/sensory/focus_controller.js',
    reason: 'status'
  });
  const outcomePolicy = loadOutcomeFitnessPolicy(REPO_ROOT);
  const gate = resolveMinFocusScore(state.policy || {}, state.recent_focus_items || {}, Date.now(), outcomePolicy);
  const triggerRows = Array.isArray(state.triggers) ? state.triggers : [];
  const lensRows = state.eye_lenses && typeof state.eye_lenses === 'object' ? Object.values(state.eye_lenses) : [];
  return {
    ok: true,
    ts: nowIso(),
    policy: state.policy || {},
    dynamic_focus_gate: gate,
    outcome_tuning: resolveOutcomeTuning(outcomePolicy),
    last_refresh_ts: state.last_refresh_ts || null,
    trigger_count: triggerRows.length,
    top_triggers: triggerRows
      .slice()
      .sort((a, b) => Number(b.weight || 0) - Number(a.weight || 0))
      .slice(0, 10)
      .map((t) => ({
        key: t.key,
        weight: Number(t.weight || 0),
        source: t.source || 'auto',
        hit_count: Number(t.hit_count || 0),
        last_hit_ts: t.last_hit_ts || null
      })),
    lens_count: lensRows.length,
    last_lens_refresh_ts: state.last_lens_refresh_ts || null,
    lens_source_summary: state.last_lens_refresh_sources || {},
    top_lenses: lensRows
      .slice()
      .sort((a, b) => Number(b.focus_hits_total || 0) - Number(a.focus_hits_total || 0))
      .slice(0, 8)
      .map((l) => ({
        eye_id: String(l.eye_id || ''),
        focus_hits_total: Number(l.focus_hits_total || 0),
        update_count: Number(l.update_count || 0),
        include_terms: (Array.isArray(l.include_terms) ? l.include_terms : []).slice(0, 8),
        exclude_terms: (Array.isArray(l.exclude_terms) ? l.exclude_terms : []).slice(0, 6),
        updated_ts: l.updated_ts || null
      })),
    stats: state.stats || {}
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim().toLowerCase();
  const dateStr = /^\d{4}-\d{2}-\d{2}$/.test(String(args._[1] || '')) ? String(args._[1]) : todayStr();
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || args.help) {
    usage();
    process.exit(0);
  }

  if (cmd === 'status') {
    process.stdout.write(JSON.stringify(focusStatus(), null, 2) + '\n');
    process.exit(0);
  }
  if (cmd === 'refresh') {
    const out = maybeRefreshFocusTriggers({
      dateStr,
      force: args.force === true,
      reason: 'cli_refresh'
    });
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    process.exit(out && out.ok === true ? 0 : 1);
  }

  usage();
  process.exit(2);
}

module.exports = {
  maybeRefreshFocusTriggers,
  evaluateFocusForEye,
  focusStatus
};

if (require.main === module) {
  main();
}
