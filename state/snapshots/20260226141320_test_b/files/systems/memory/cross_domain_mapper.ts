#!/usr/bin/env node
'use strict';

/**
 * systems/memory/cross_domain_mapper.js
 *
 * Deterministic cross-domain mapping service:
 * - Builds structured mappings between two domain row sets.
 * - Enforces objective lineage gates via directive compiler.
 * - Scores mappings by value + novelty + provenance depth.
 *
 * This is intentionally model-free so it can be reused by dream, hyper-creative,
 * and strategy pipelines without opening an unbounded generation path.
 */

const {
  compileDirectiveLineage,
  evaluateDirectiveLineageCandidate,
  normalizeDirectiveId
} = require('../security/directive_compiler');

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'mode', 'task',
  'route', 'normal', 'creative', 'hyper', 'thinker', 'deep', 'summary', 'reason',
  'model', 'tier', 'user', 'system', 'about', 'after', 'before', 'through',
  'while', 'where', 'when', 'which', 'link', 'links'
]);

function clampInt(v, min, max, fallback = min) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function clampNumber(v, min, max, fallback = min) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function normalizeToken(v) {
  return String(v || '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function normalizeText(v, maxLen = 240) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function tokenize(v) {
  return String(v || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]+/g, ' ')
    .split(/\s+/)
    .map((x) => String(x || '').trim())
    .filter(Boolean)
    .map((x) => normalizeToken(x))
    .filter((x) => x.length >= 3 && !STOPWORDS.has(x))
    .slice(0, 12);
}

function pickDefaultObjectiveId(compiler) {
  const rows = Array.isArray(compiler && compiler.entries) ? compiler.entries : [];
  if (rows.length <= 0) return '';
  const sorted = rows.slice().sort((a, b) => {
    const at = Number(a && a.tier || 99);
    const bt = Number(b && b.tier || 99);
    if (at !== bt) return at - bt;
    return String(a && a.id || '').localeCompare(String(b && b.id || ''));
  });
  return normalizeDirectiveId(sorted[0] && sorted[0].id) || '';
}

function toDomainRows(rows, fallbackDomain = 'domain') {
  const src = Array.isArray(rows) ? rows : [];
  const out = [];
  for (const row of src) {
    if (!row || typeof row !== 'object') continue;
    const token = normalizeToken(row.token || row.key || row.id || '');
    const title = normalizeText(row.title || row.hint || row.summary || '');
    const terms = Array.from(new Set([
      ...tokenize(token.replace(/-/g, ' ')),
      ...tokenize(title),
      ...tokenize(row.keywords || '')
    ])).slice(0, 12);
    if (!token && terms.length <= 0) continue;
    const refs = Array.isArray(row.refs)
      ? row.refs.map((r) => normalizeText(r, 180)).filter((r) => r.includes('#')).slice(0, 12)
      : [];
    const objectiveId = normalizeDirectiveId(
      row.objective_id
      || row.directive_objective_id
      || row.root_objective_id
      || ''
    );
    const score = clampNumber(
      row.score != null ? row.score : (row.avg_score_window != null ? row.avg_score_window : 0),
      0,
      1000,
      0
    );
    const occurrences = clampInt(
      row.occurrences_window != null ? row.occurrences_window : (row.sample_count != null ? row.sample_count : 1),
      1,
      100000,
      1
    );
    out.push({
      domain: normalizeToken(row.domain || fallbackDomain) || normalizeToken(fallbackDomain) || 'domain',
      token: token || terms.slice(0, 3).join('-'),
      title,
      terms,
      refs,
      objective_id: objectiveId || '',
      score,
      occurrences
    });
  }
  return out;
}

function mapCrossDomainRows(input = {}, opts = {}) {
  const rowsA = toDomainRows(input.rows_a || input.rowsA || [], input.domain_a || input.domainA || 'domain_a');
  const rowsB = toDomainRows(input.rows_b || input.rowsB || [], input.domain_b || input.domainB || 'domain_b');
  const maxMappings = clampInt(
    opts.max_mappings != null ? opts.max_mappings : process.env.CROSS_DOMAIN_MAX_MAPPINGS,
    1,
    40,
    12
  );
  const minPairScore = clampNumber(
    opts.min_pair_score != null ? opts.min_pair_score : process.env.CROSS_DOMAIN_MIN_PAIR_SCORE,
    0.1,
    5000,
    8
  );
  const minValueScore = clampNumber(
    opts.min_value_score != null ? opts.min_value_score : process.env.CROSS_DOMAIN_MIN_VALUE_SCORE,
    0.1,
    5000,
    8
  );
  const requireObjective = opts.require_objective != null
    ? opts.require_objective === true
    : String(process.env.CROSS_DOMAIN_REQUIRE_OBJECTIVE || '1').trim() !== '0';
  const requireT1Root = opts.require_t1_root != null
    ? opts.require_t1_root === true
    : String(process.env.CROSS_DOMAIN_REQUIRE_T1_ROOT || '1').trim() !== '0';
  const noveltyIndex = opts.novelty_index && typeof opts.novelty_index === 'object'
    ? opts.novelty_index
    : {};

  const compiler = opts.compiler && typeof opts.compiler.resolveObjective === 'function'
    ? opts.compiler
    : compileDirectiveLineage({
      activePath: opts.active_path,
      directivesDir: opts.directives_dir
    });
  const explicitDefaultObjective = normalizeDirectiveId(opts.default_objective_id || process.env.CROSS_DOMAIN_DEFAULT_OBJECTIVE_ID || '');
  const defaultObjectiveId = explicitDefaultObjective || pickDefaultObjectiveId(compiler);

  const merged = new Map();
  let scannedPairs = 0;
  for (const a of rowsA) {
    const termsA = new Set(Array.isArray(a.terms) ? a.terms : []);
    for (const b of rowsB) {
      scannedPairs += 1;
      const overlap = (Array.isArray(b.terms) ? b.terms : []).filter((t) => termsA.has(t));
      if (overlap.length <= 0) continue;
      const shared = Array.from(new Set(overlap)).slice(0, 4);
      const mappingToken = normalizeToken(shared.join('-'));
      if (!mappingToken) continue;
      const pairScore = (
        Math.min(Number(a.score || 0), Number(b.score || 0))
        + (shared.length * 5)
        + Math.min(20, Math.sqrt(Number(a.occurrences || 1) * Number(b.occurrences || 1)))
      );
      if (!Number.isFinite(pairScore) || pairScore < minPairScore) continue;
      if (!merged.has(mappingToken)) {
        merged.set(mappingToken, {
          token: mappingToken,
          score_sum: 0,
          pair_count: 0,
          refs: new Set(),
          source_tokens_a: new Set(),
          source_tokens_b: new Set(),
          source_domains: new Set(),
          objective_votes: new Map(),
          sample_pairs: []
        });
      }
      const bucket = merged.get(mappingToken);
      bucket.score_sum += pairScore;
      bucket.pair_count += 1;
      bucket.source_domains.add(a.domain);
      bucket.source_domains.add(b.domain);
      bucket.source_tokens_a.add(a.token);
      bucket.source_tokens_b.add(b.token);
      for (const r of [...a.refs, ...b.refs]) bucket.refs.add(r);
      const objectiveCandidates = [a.objective_id, b.objective_id, defaultObjectiveId]
        .map((x) => normalizeDirectiveId(x))
        .filter(Boolean);
      for (const objectiveId of objectiveCandidates) {
        bucket.objective_votes.set(objectiveId, Number(bucket.objective_votes.get(objectiveId) || 0) + 1);
      }
      if (bucket.sample_pairs.length < 6) {
        bucket.sample_pairs.push({
          from_a: a.token,
          from_b: b.token,
          overlap: shared,
          pair_score: Number(pairScore.toFixed(3))
        });
      }
    }
  }

  const rejected = {
    objective_missing: 0,
    objective_invalid: 0,
    value_too_low: 0
  };
  const mappings = [];
  for (const row of merged.values()) {
    const baseScore = Number((row.score_sum / Math.max(1, row.pair_count)).toFixed(3));
    const noveltySeen = Math.max(0, Number(noveltyIndex[row.token] || 0));
    const noveltyScore = Number((1 / (1 + noveltySeen)).toFixed(6));
    const valueScore = Number((baseScore * noveltyScore).toFixed(3));
    const objectiveId = Array.from(row.objective_votes.entries())
      .sort((a, b) => {
        if (Number(b[1] || 0) !== Number(a[1] || 0)) return Number(b[1] || 0) - Number(a[1] || 0);
        return String(a[0]).localeCompare(String(b[0]));
      })
      .map((entry) => normalizeDirectiveId(entry[0]))
      .find(Boolean)
      || '';
    if (!objectiveId && requireObjective) {
      rejected.objective_missing += 1;
      continue;
    }
    const lineage = evaluateDirectiveLineageCandidate(
      { objective_id: objectiveId || defaultObjectiveId || '' },
      {
        compiler,
        require_t1_root: requireT1Root,
        block_missing_objective: requireObjective
      }
    );
    if (lineage.pass !== true) {
      rejected.objective_invalid += 1;
      continue;
    }
    if (valueScore < minValueScore) {
      rejected.value_too_low += 1;
      continue;
    }
    mappings.push({
      token: row.token,
      pair_count: row.pair_count,
      base_score: baseScore,
      novelty_score: noveltyScore,
      value_score: valueScore,
      refs: Array.from(row.refs).slice(0, 16),
      source_domains: Array.from(row.source_domains).sort(),
      source_tokens_a: Array.from(row.source_tokens_a).slice(0, 12),
      source_tokens_b: Array.from(row.source_tokens_b).slice(0, 12),
      objective_id: lineage.objective_id || objectiveId || defaultObjectiveId || '',
      root_objective_id: lineage.root_objective_id || null,
      lineage_path: Array.isArray(lineage.lineage_path) ? lineage.lineage_path.slice(0, 12) : [],
      sample_pairs: row.sample_pairs
    });
  }

  mappings.sort((a, b) => {
    if (Number(b.value_score || 0) !== Number(a.value_score || 0)) return Number(b.value_score || 0) - Number(a.value_score || 0);
    if (Number(b.pair_count || 0) !== Number(a.pair_count || 0)) return Number(b.pair_count || 0) - Number(a.pair_count || 0);
    return String(a.token || '').localeCompare(String(b.token || ''));
  });

  return {
    ok: true,
    type: 'cross_domain_mapper',
    scanned_pairs: scannedPairs,
    candidates: merged.size,
    selected: mappings.slice(0, maxMappings),
    rejected,
    policy: {
      max_mappings: maxMappings,
      min_pair_score: minPairScore,
      min_value_score: minValueScore,
      require_objective: requireObjective,
      require_t1_root: requireT1Root,
      default_objective_id: defaultObjectiveId || null,
      compiler_hash: compiler && compiler.hash ? compiler.hash : null
    }
  };
}

module.exports = {
  mapCrossDomainRows,
  toDomainRows
};

