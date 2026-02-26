#!/usr/bin/env node
'use strict';

/**
 * systems/memory/creative_links.js
 *
 * Deterministic "creative link" promoter:
 * - Harvests themes from dream sheets (state/memory/dreams/*.json)
 * - Harvests creative intent traces from hyper-creative routing runs
 * - Scores usefulness over a rolling window
 * - Promotes useful themes into first-class memory nodes (with UIDs)
 *
 * Usage:
 *   node systems/memory/creative_links.js run [YYYY-MM-DD] [--days=7] [--top=16] [--max-promotions=3]
 *   node systems/memory/creative_links.js status [YYYY-MM-DD]
 *   node systems/memory/creative_links.js --help
 */

const fs = require('fs');
const path = require('path');
const { stableUid } = require('../../lib/uid');
const { enforceMutationProvenance, recordMutationAudit } = require('../../lib/mutation_provenance');

const SCRIPT_SOURCE = 'systems/memory/creative_links.js';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DREAMS_DIR = process.env.CREATIVE_LINKS_DREAMS_DIR
  ? path.resolve(String(process.env.CREATIVE_LINKS_DREAMS_DIR))
  : path.join(REPO_ROOT, 'state', 'memory', 'dreams');
const ROUTING_DECISIONS_PATH = process.env.CREATIVE_LINKS_ROUTING_DECISIONS_PATH
  ? path.resolve(String(process.env.CREATIVE_LINKS_ROUTING_DECISIONS_PATH))
  : path.join(REPO_ROOT, 'state', 'routing', 'routing_decisions.jsonl');
const REGISTRY_PATH = process.env.CREATIVE_LINKS_REGISTRY_PATH
  ? path.resolve(String(process.env.CREATIVE_LINKS_REGISTRY_PATH))
  : path.join(REPO_ROOT, 'state', 'memory', 'creative_links', 'registry.json');
const LEDGER_PATH = process.env.CREATIVE_LINKS_LEDGER_PATH
  ? path.resolve(String(process.env.CREATIVE_LINKS_LEDGER_PATH))
  : path.join(REPO_ROOT, 'state', 'memory', 'creative_links', 'runs.jsonl');
const MEMORY_DIR = process.env.CREATIVE_LINKS_MEMORY_DIR
  ? path.resolve(String(process.env.CREATIVE_LINKS_MEMORY_DIR))
  : path.join(REPO_ROOT, 'memory');

const DEFAULT_DAYS = clampInt(process.env.CREATIVE_LINKS_DAYS || 7, 2, 30);
const DEFAULT_TOP = clampInt(process.env.CREATIVE_LINKS_TOP || 16, 1, 40);
const DEFAULT_MAX_PROMOTIONS = clampInt(process.env.CREATIVE_LINKS_MAX_PROMOTIONS || 3, 1, 10);
const MIN_OCCURRENCES = clampInt(process.env.CREATIVE_LINKS_MIN_OCCURRENCES || 2, 2, 10);
const MIN_AVG_SCORE = clampNumber(process.env.CREATIVE_LINKS_MIN_AVG_SCORE || 12, 1, 100);
const MIN_OLDER_REFS = clampInt(process.env.CREATIVE_LINKS_MIN_OLDER_REFS || 1, 0, 10);
const MIN_ROW_REFS = clampInt(process.env.CREATIVE_LINKS_MIN_ROW_REFS || 2, 0, 20);
const CROSS_DOMAIN_MAPPER_ENABLED = String(process.env.CREATIVE_LINKS_CROSS_DOMAIN_ENABLED || '1').trim() !== '0';
const CROSS_DOMAIN_MIN_BRIDGE_REFS = clampInt(process.env.CREATIVE_LINKS_CROSS_DOMAIN_MIN_BRIDGE_REFS || 1, 1, 16);
const HYPER_TOKEN_WORDS = clampInt(process.env.CREATIVE_LINKS_HYPER_TOKEN_WORDS || 4, 2, 8);
const HYPER_MAX_ROWS = clampInt(process.env.CREATIVE_LINKS_HYPER_MAX_ROWS || 4000, 50, 50000);
const HYPER_STOPWORDS = new Set([
  'and', 'the', 'for', 'with', 'from', 'into', 'that', 'this', 'then', 'than',
  'task', 'mode', 'normal', 'creative', 'hyper', 'thinker', 'deep', 'route'
]);

function usage() {
  console.log('Usage:');
  console.log('  node systems/memory/creative_links.js run [YYYY-MM-DD] [--days=7] [--top=16] [--max-promotions=3]');
  console.log('  node systems/memory/creative_links.js status [YYYY-MM-DD]');
  console.log('  node systems/memory/creative_links.js --help');
}

function parseArgs(argv) {
  const out = { _: [] } as Record<string, any>;
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i] || '');
    if (!a.startsWith('--')) {
      out._.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    if (eq >= 0) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next != null && !String(next).startsWith('--')) {
      out[key] = next;
      i += 1;
      continue;
    }
    out[key] = true;
  }
  return out;
}

function clampInt(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function clampNumber(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function nowIso() {
  return new Date().toISOString();
}

function toDate(v) {
  const s = String(v || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return new Date().toISOString().slice(0, 10);
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

function writeJson(filePath, obj) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function appendJsonl(filePath, obj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, JSON.stringify(obj) + '\n', 'utf8');
}

function readJsonlRows(filePath, maxRows) {
  if (!fs.existsSync(filePath)) return [];
  const text = fs.readFileSync(filePath, 'utf8');
  const lines = String(text || '').split(/\r?\n/);
  const out = [];
  const start = Math.max(0, lines.length - maxRows);
  for (let i = start; i < lines.length; i++) {
    const line = String(lines[i] || '').trim();
    if (!line) continue;
    try {
      out.push({ row: JSON.parse(line), line: i + 1 });
    } catch {
      // Skip malformed lines deterministically.
    }
  }
  return out;
}

function dateDaysBack(endDate, days) {
  const out = [];
  const end = new Date(`${endDate}T12:00:00.000Z`);
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(end);
    d.setUTCDate(d.getUTCDate() - i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

function normalizeToken(v) {
  return String(v || '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function cleanLine(v, maxLen = 220) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function defaultRegistry() {
  return {
    version: '1.0',
    updated_ts: null,
    candidates: {}
  };
}

function loadRegistry() {
  const base = readJsonSafe(REGISTRY_PATH, defaultRegistry());
  if (!base || typeof base !== 'object') return defaultRegistry();
  if (!base.candidates || typeof base.candidates !== 'object') base.candidates = {};
  return base;
}

function saveRegistry(registry) {
  const next = registry && typeof registry === 'object' ? registry : defaultRegistry();
  if (!next.candidates || typeof next.candidates !== 'object') next.candidates = {};
  next.updated_ts = nowIso();
  writeJson(REGISTRY_PATH, next);
}

function collectRefs(theme) {
  const out = [];
  const older = Array.isArray(theme && theme.older_refs) ? theme.older_refs : [];
  const rows = Array.isArray(theme && theme.rows) ? theme.rows : [];
  for (const r of older) {
    const ref = `${cleanLine(r && r.file, 140)}#${cleanLine(r && r.node_id, 80)}`;
    if (!ref.startsWith('#') && !out.includes(ref)) out.push(ref);
  }
  for (const r of rows) {
    const ref = `${cleanLine(r && r.memory_file, 140)}#${cleanLine(r && r.node_id, 80)}`;
    if (!ref.startsWith('#') && !out.includes(ref)) out.push(ref);
  }
  return out.slice(0, 12);
}

function collectDreamThemes(dateStr, days, top) {
  const dates = dateDaysBack(dateStr, days);
  const byToken = new Map();
  for (const d of dates) {
    const fp = path.join(DREAMS_DIR, `${d}.json`);
    const obj = readJsonSafe(fp, null);
    if (!obj || !Array.isArray(obj.themes)) continue;
    const themes = obj.themes.slice(0, top);
    for (const t of themes) {
      const token = normalizeToken(t && t.token);
      if (!token) continue;
      if (!byToken.has(token)) {
        byToken.set(token, {
          token,
          observed_dates: new Set(),
          scores: [],
          older_refs: 0,
          row_refs: 0,
          refs: [],
          latest_score: 0,
          latest_date: null
        });
      }
      const ent = byToken.get(token);
      const score = Number(t && t.score || 0);
      ent.observed_dates.add(d);
      ent.scores.push(Number.isFinite(score) ? score : 0);
      ent.older_refs += Array.isArray(t && t.older_refs) ? t.older_refs.length : 0;
      ent.row_refs += Array.isArray(t && t.rows) ? t.rows.length : 0;
      ent.refs = Array.from(new Set([...ent.refs, ...collectRefs(t)])).slice(0, 16);
      if (ent.latest_date == null || d >= ent.latest_date) {
        ent.latest_date = d;
        ent.latest_score = Number.isFinite(score) ? score : 0;
      }
    }
  }

  return Array.from(byToken.values()).map((ent) => {
    const scores = ent.scores.length ? ent.scores : [0];
    const avgScore = scores.reduce((s, x) => s + x, 0) / scores.length;
    const maxScore = Math.max(...scores);
    const observedDates = Array.from(ent.observed_dates).sort();
    const crossDomainEvidence = CROSS_DOMAIN_MAPPER_ENABLED
      && (
        Number(ent.older_refs || 0) >= CROSS_DOMAIN_MIN_BRIDGE_REFS
        || (Number(ent.older_refs || 0) > 0 && Number(ent.row_refs || 0) > 0)
      );
    const sourceTypes = crossDomainEvidence
      ? ['cross_domain_mapper', 'memory_dream']
      : ['memory_dream'];
    const sourceCounts = {
      memory_dream: scores.length
    } as Record<string, number>;
    if (crossDomainEvidence) {
      sourceCounts.cross_domain_mapper = Math.max(1, Number(ent.older_refs || 0));
    }
    return {
      token: ent.token,
      occurrences_window: observedDates.length,
      avg_score_window: Number(avgScore.toFixed(3)),
      max_score_window: Number(maxScore.toFixed(3)),
      sample_count: scores.length,
      older_refs_window: ent.older_refs,
      row_refs_window: ent.row_refs,
      observed_dates: observedDates,
      latest_score: ent.latest_score,
      latest_date: ent.latest_date,
      refs: ent.refs.slice(0, 16),
      source_types: sourceTypes,
      source_counts: sourceCounts
    };
  });
}

function normalizeDate(v) {
  const raw = String(v == null ? '' : v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const d = new Date(raw);
  if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return null;
}

function isHyperCreativeMode(v) {
  const norm = String(v == null ? '' : v).trim().toLowerCase().replace(/_/g, '-');
  return norm === 'hyper-creative';
}

function summarizeHyperText(row) {
  const pick = [
    row && row.intent,
    row && row.task,
    row && row.reason,
    row && row.mode_reason,
    row && row.handoff_packet && row.handoff_packet.reason
  ];
  for (const p of pick) {
    const s = cleanLine(p, 240);
    if (s.length >= 6) return s;
  }
  return '';
}

function tokenFromHyperText(text) {
  const words = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]+/g, ' ')
    .split(/\s+/)
    .map((w) => w.trim())
    .filter(Boolean)
    .filter((w) => w.length >= 3)
    .filter((w) => !HYPER_STOPWORDS.has(w))
    .slice(0, HYPER_TOKEN_WORDS);
  return normalizeToken(words.join('-'));
}

function collectHyperCreativeThemes(dateStr, days) {
  const dates = new Set(dateDaysBack(dateStr, days));
  const rows = readJsonlRows(ROUTING_DECISIONS_PATH, HYPER_MAX_ROWS);
  const byToken = new Map();

  for (const entry of rows) {
    const row = entry && entry.row ? entry.row : null;
    if (!row || typeof row !== 'object') continue;
    const mode = row.mode || (row.handoff_packet && row.handoff_packet.mode) || null;
    if (!isHyperCreativeMode(mode)) continue;

    const date = normalizeDate(row.ts) || normalizeDate(row.date);
    if (!date || !dates.has(date)) continue;

    const summary = summarizeHyperText(row);
    const token = tokenFromHyperText(summary);
    if (!token) continue;
    if (!byToken.has(token)) {
      byToken.set(token, {
        token,
        observed_dates: new Set(),
        scores: [],
        row_refs: 0,
        refs: [],
        latest_score: 0,
        latest_date: null
      });
    }
    const ent = byToken.get(token);
    const tier = clampInt(row && row.tier, 1, 3);
    const score = 10 + (tier * 2) + (row && row.model_changed ? 1 : 0);
    ent.observed_dates.add(date);
    ent.scores.push(score);
    ent.row_refs += 1;
    const ref = `${path.relative(REPO_ROOT, ROUTING_DECISIONS_PATH).replace(/\\/g, '/')}#L${entry.line}`;
    if (!ent.refs.includes(ref)) ent.refs.push(ref);
    if (ent.latest_date == null || date >= ent.latest_date) {
      ent.latest_date = date;
      ent.latest_score = score;
    }
  }

  return Array.from(byToken.values()).map((ent) => {
    const scores = ent.scores.length ? ent.scores : [0];
    const avgScore = scores.reduce((s, x) => s + x, 0) / scores.length;
    const maxScore = Math.max(...scores);
    const observedDates = Array.from(ent.observed_dates).sort();
    return {
      token: ent.token,
      occurrences_window: observedDates.length,
      avg_score_window: Number(avgScore.toFixed(3)),
      max_score_window: Number(maxScore.toFixed(3)),
      sample_count: scores.length,
      older_refs_window: 0,
      row_refs_window: ent.row_refs,
      observed_dates: observedDates,
      latest_score: ent.latest_score,
      latest_date: ent.latest_date,
      refs: ent.refs.slice(0, 16),
      source_types: ['hyper_creative_mode'],
      source_counts: { hyper_creative_mode: scores.length }
    };
  });
}

function mergeEvidenceRows(rows) {
  const byToken = new Map();
  for (const row of rows) {
    const token = normalizeToken(row && row.token);
    if (!token) continue;
    if (!byToken.has(token)) {
      byToken.set(token, {
        token,
        observed_dates: new Set(),
        score_sum: 0,
        score_weight: 0,
        max_score_window: 0,
        older_refs_window: 0,
        row_refs_window: 0,
        refs: [],
        latest_score: 0,
        latest_date: null,
        source_types: new Set(),
        source_counts: {}
      });
    }
    const ent = byToken.get(token);
    const observedDates = Array.isArray(row && row.observed_dates) ? row.observed_dates : [];
    for (const d of observedDates) {
      const normDate = normalizeDate(d);
      if (normDate) ent.observed_dates.add(normDate);
    }
    const weight = Math.max(1, Number(row && row.sample_count || row && row.occurrences_window || 1));
    const avg = Number(row && row.avg_score_window || 0);
    const max = Number(row && row.max_score_window || avg);
    ent.score_sum += avg * weight;
    ent.score_weight += weight;
    ent.max_score_window = Math.max(ent.max_score_window, max);
    ent.older_refs_window += Number(row && row.older_refs_window || 0);
    ent.row_refs_window += Number(row && row.row_refs_window || 0);
    ent.refs = Array.from(new Set([...ent.refs, ...((row && row.refs) || [])])).slice(0, 16);
    const latestDate = normalizeDate(row && row.latest_date);
    if (latestDate && (!ent.latest_date || latestDate >= ent.latest_date)) {
      ent.latest_date = latestDate;
      ent.latest_score = Number(row && row.latest_score || 0);
    }
    const sourceTypes = Array.isArray(row && row.source_types) ? row.source_types : [];
    for (const src of sourceTypes) {
      const cleanSrc = normalizeToken(src);
      if (cleanSrc) ent.source_types.add(cleanSrc);
    }
    const sourceCounts = row && row.source_counts && typeof row.source_counts === 'object'
      ? row.source_counts
      : {};
    for (const [k, v] of Object.entries(sourceCounts)) {
      const cleanSrc = normalizeToken(k);
      if (!cleanSrc) continue;
      ent.source_counts[cleanSrc] = Number(ent.source_counts[cleanSrc] || 0) + Number(v || 0);
    }
  }

  return Array.from(byToken.values()).map((ent) => {
    const observedDates = Array.from(ent.observed_dates).sort();
    return {
      token: ent.token,
      occurrences_window: observedDates.length,
      avg_score_window: Number((ent.score_sum / Math.max(1, ent.score_weight)).toFixed(3)),
      max_score_window: Number(ent.max_score_window.toFixed(3)),
      sample_count: ent.score_weight,
      older_refs_window: ent.older_refs_window,
      row_refs_window: ent.row_refs_window,
      observed_dates: observedDates,
      latest_score: ent.latest_score,
      latest_date: ent.latest_date,
      refs: ent.refs.slice(0, 16),
      source_types: Array.from(ent.source_types).sort(),
      source_counts: ent.source_counts
    };
  });
}

function collectThemes(dateStr, days, top) {
  const dreamThemes = collectDreamThemes(dateStr, days, top);
  const hyperThemes = collectHyperCreativeThemes(dateStr, days);
  return mergeEvidenceRows([...dreamThemes, ...hyperThemes]);
}

function summarizeCrossDomainMapper(evidenceRows) {
  const rows = Array.isArray(evidenceRows) ? evidenceRows : [];
  const contributed = rows
    .filter((row) => Array.isArray(row && row.source_types) && row.source_types.includes('cross_domain_mapper'));
  const sourceRows = contributed.reduce((sum, row) => {
    const counts = row && row.source_counts && typeof row.source_counts === 'object' ? row.source_counts : {};
    return sum + Number(counts.cross_domain_mapper || 0);
  }, 0);
  return {
    enabled: CROSS_DOMAIN_MAPPER_ENABLED,
    tokens_contributed: contributed.length,
    source_rows: sourceRows,
    top_tokens: contributed
      .sort((a, b) => Number(b.avg_score_window || 0) - Number(a.avg_score_window || 0))
      .slice(0, 8)
      .map((row) => String(row && row.token || ''))
      .filter(Boolean)
  };
}

function passGate(e) {
  const gateOccurrences = Number(e.occurrences_window || 0) >= MIN_OCCURRENCES;
  const gateSignal = Number(e.avg_score_window || 0) >= MIN_AVG_SCORE;
  const gateMemory = Number(e.older_refs_window || 0) >= MIN_OLDER_REFS
    || Number(e.row_refs_window || 0) >= MIN_ROW_REFS;
  const useful = gateOccurrences && (gateSignal || gateMemory);
  return {
    useful,
    gate_occurrences: gateOccurrences,
    gate_signal: gateSignal,
    gate_memory: gateMemory
  };
}

function existingNodeIds(memoryPath) {
  if (!fs.existsSync(memoryPath)) return new Set();
  const text = fs.readFileSync(memoryPath, 'utf8');
  const ids = new Set();
  const re = /^\s*node_id:\s*([A-Za-z0-9._-]+)\s*$/gm;
  let m = re.exec(text);
  while (m) {
    if (m[1]) ids.add(String(m[1]));
    m = re.exec(text);
  }
  return ids;
}

function uniqueNodeId(base, seen) {
  if (!seen.has(base)) return base;
  for (let i = 2; i <= 99; i++) {
    const next = `${base}-${i}`;
    if (!seen.has(next)) return next;
  }
  return `${base}-${Date.now()}`;
}

function appendCreativeNode(dateStr, candidate) {
  ensureDir(MEMORY_DIR);
  const memoryPath = path.join(MEMORY_DIR, `${dateStr}.md`);
  const seen = existingNodeIds(memoryPath);
  const baseNodeId = `creative-link-${normalizeToken(candidate.token)}-${String(candidate.id || '').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(-6)}`;
  const nodeId = uniqueNodeId(baseNodeId, seen);
  const uid = stableUid(`memory_creative_link|${candidate.token}|${dateStr}|v1`, { prefix: 'clm', length: 24 });

  const edgeIds = [];
  for (const r of candidate.refs || []) {
    const m = String(r || '').match(/#([A-Za-z0-9._-]+)\s*$/);
    if (m && m[1] && !edgeIds.includes(m[1])) edgeIds.push(m[1]);
  }

  const tags = Array.from(new Set(['creative-link', 'dream', 'memory', normalizeToken(candidate.token)])).filter(Boolean);
  const sources = Array.isArray(candidate && candidate.source_types) ? candidate.source_types : ['memory_dream'];
  const lines = [
    '---',
    `date: ${dateStr}`,
    `node_id: ${nodeId}`,
    `uid: ${uid}`,
    `tags: [${tags.join(', ')}]`,
    `edges_to: [${edgeIds.slice(0, 8).join(', ')}]`,
    '---',
    '',
    `# ${nodeId}`,
    '',
    '## Creative Link',
    '',
    `- Theme token: ${candidate.token}`,
    `- Source: ${sources.join(', ')}`,
    `- Evidence window: occurrences=${candidate.occurrences_window}, avg_score=${candidate.avg_score_window}, max_score=${candidate.max_score_window}`,
    `- Memory anchors: older_refs=${candidate.older_refs_window}, row_refs=${candidate.row_refs_window}`,
    `- Observed dates: ${(candidate.observed_dates || []).join(', ') || 'n/a'}`,
    '',
    '## Linked Memory',
    ''
  ];

  const refs = Array.isArray(candidate.refs) ? candidate.refs : [];
  if (refs.length === 0) {
    lines.push('- No explicit refs captured; retained as a thematic crystallization.');
  } else {
    for (const r of refs.slice(0, 10)) {
      lines.push(`- ${cleanLine(r, 220)}`);
    }
  }
  lines.push('');

  const nodeText = lines.join('\n');
  const exists = fs.existsSync(memoryPath);
  if (!exists || fs.readFileSync(memoryPath, 'utf8').trim().length === 0) {
    fs.writeFileSync(memoryPath, nodeText + '\n', 'utf8');
  } else {
    fs.appendFileSync(memoryPath, `\n\n<!-- NODE -->\n\n${nodeText}\n`, 'utf8');
  }

  return {
    node_id: nodeId,
    uid,
    memory_file: path.relative(REPO_ROOT, memoryPath).replace(/\\/g, '/')
  };
}

function upsertCandidates(registry, evidenceRows) {
  const promoted = [];
  const candidates = registry.candidates || {};
  for (const e of evidenceRows) {
    const token = normalizeToken(e.token);
    if (!token) continue;
    const existing = candidates[token] && typeof candidates[token] === 'object'
      ? { ...candidates[token] }
      : null;
    const gate = passGate(e);
    const next = {
      id: existing ? existing.id : `CRL-${stableUid(`creative_link|${token}|v1`, { prefix: 'c', length: 16 }).toUpperCase()}`,
      uid: existing && String(existing.uid || '').trim()
        ? String(existing.uid)
        : stableUid(`creative_link_candidate|${token}|v1`, { prefix: 'cl', length: 24 }),
      token,
      status: existing ? String(existing.status || 'proposed') : 'proposed',
      created_ts: existing ? existing.created_ts || nowIso() : nowIso(),
      updated_ts: nowIso(),
      usefulness: gate,
      occurrences_window: Number(e.occurrences_window || 0),
      avg_score_window: Number(e.avg_score_window || 0),
      max_score_window: Number(e.max_score_window || 0),
      older_refs_window: Number(e.older_refs_window || 0),
      row_refs_window: Number(e.row_refs_window || 0),
      observed_dates: Array.isArray(e.observed_dates) ? e.observed_dates.slice(0, 30) : [],
      latest_date: e.latest_date || null,
      latest_score: Number(e.latest_score || 0),
      refs: Array.isArray(e.refs) ? e.refs.slice(0, 16) : [],
      source_types: Array.isArray(e.source_types) ? e.source_types.slice(0, 8) : [],
      source_counts: (e.source_counts && typeof e.source_counts === 'object') ? { ...e.source_counts } : {},
      promoted_ts: existing ? existing.promoted_ts || null : null,
      promoted_node_id: existing ? existing.promoted_node_id || null : null,
      promoted_uid: existing ? existing.promoted_uid || null : null,
      promoted_memory_file: existing ? existing.promoted_memory_file || null : null
    };
    candidates[token] = next;
    promoted.push(next);
  }
  registry.candidates = candidates;
  return promoted;
}

function runCmd(dateStr, days, top, maxPromotions) {
  const provenance = enforceMutationProvenance('memory', {
    source: SCRIPT_SOURCE,
    reason: 'creative_links_run'
  }, {
    fallbackSource: SCRIPT_SOURCE,
    defaultReason: 'creative_links_run',
    context: `run:${dateStr}`
  });
  const registry = loadRegistry();
  const evidence = collectThemes(dateStr, days, top);
  const crossDomainMapper = summarizeCrossDomainMapper(evidence);
  const candidates = upsertCandidates(registry, evidence);

  const promotable = candidates
    .filter((c) => c.usefulness && c.usefulness.useful === true)
    .filter((c) => String(c.status || 'proposed') !== 'promoted')
    .sort((a, b) => {
      if (b.occurrences_window !== a.occurrences_window) return b.occurrences_window - a.occurrences_window;
      if (b.avg_score_window !== a.avg_score_window) return b.avg_score_window - a.avg_score_window;
      return String(a.token).localeCompare(String(b.token));
    })
    .slice(0, maxPromotions);

  const promotions = [];
  for (const c of promotable) {
    const node = appendCreativeNode(dateStr, c);
    c.status = 'promoted';
    c.promoted_ts = nowIso();
    c.promoted_node_id = node.node_id;
    c.promoted_uid = node.uid;
    c.promoted_memory_file = node.memory_file;
    c.updated_ts = nowIso();
    registry.candidates[c.token] = c;
    promotions.push({
      token: c.token,
      candidate_id: c.id,
      node_id: node.node_id,
      node_uid: node.uid,
      memory_file: node.memory_file
    });
  }

  saveRegistry(registry);
  const out = {
    ok: true,
    type: 'creative_links_run',
    date: dateStr,
    days,
    themes_considered: evidence.length,
    candidates_total: Object.keys(registry.candidates || {}).length,
    promotable_count: promotable.length,
    promoted_count: promotions.length,
    promotions,
    cross_domain_mapper: crossDomainMapper
  };
  appendJsonl(LEDGER_PATH, {
    ts: nowIso(),
    type: 'creative_links_run',
    date: dateStr,
    days,
    themes_considered: out.themes_considered,
    candidates_total: out.candidates_total,
    promoted_count: out.promoted_count
  });
  const touched = [
    path.relative(REPO_ROOT, REGISTRY_PATH).replace(/\\/g, '/'),
    path.relative(REPO_ROOT, LEDGER_PATH).replace(/\\/g, '/')
  ];
  for (const p of promotions) {
    if (p && p.memory_file) touched.push(String(p.memory_file));
  }
  recordMutationAudit('memory', {
    type: 'controller_run',
    controller: SCRIPT_SOURCE,
    operation: 'creative_links_run',
    source: provenance.meta && provenance.meta.source || SCRIPT_SOURCE,
    reason: provenance.meta && provenance.meta.reason || 'creative_links_run',
    provenance_ok: provenance.ok === true,
    provenance_violations: Array.isArray(provenance.violations) ? provenance.violations : [],
    files_touched: Array.from(new Set(touched)).filter(Boolean),
    metrics: {
      themes_considered: out.themes_considered,
      candidates_total: out.candidates_total,
      promotable_count: out.promotable_count,
      promoted_count: out.promoted_count
    }
  });
  return out;
}

function statusCmd(dateStr) {
  const registry = loadRegistry();
  const all = Object.values(registry.candidates || {}) as Array<Record<string, any>>;
  const promotedToday = all.filter((c) => String(c && c.promoted_ts || '').slice(0, 10) === dateStr);
  return {
    ok: true,
    type: 'creative_links_status',
    date: dateStr,
    candidates_total: all.length,
    proposed: all.filter((c) => String(c.status || '') !== 'promoted').length,
    promoted: all.filter((c) => String(c.status || '') === 'promoted').length,
    promoted_today: promotedToday.length,
    registry_path: path.relative(REPO_ROOT, REGISTRY_PATH).replace(/\\/g, '/')
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim().toLowerCase();
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'run') {
    const dateStr = toDate(args._[1]);
    const days = clampInt(args.days == null ? DEFAULT_DAYS : args.days, 2, 30);
    const top = clampInt(args.top == null ? DEFAULT_TOP : args.top, 1, 40);
    const maxPromotions = clampInt(
      args['max-promotions'] == null ? DEFAULT_MAX_PROMOTIONS : args['max-promotions'],
      1,
      10
    );
    process.stdout.write(JSON.stringify(runCmd(dateStr, days, top, maxPromotions)) + '\n');
    return;
  }
  if (cmd === 'status') {
    const dateStr = toDate(args._[1]);
    process.stdout.write(JSON.stringify(statusCmd(dateStr)) + '\n');
    return;
  }
  usage();
  process.exit(2);
}

if (require.main === module) {
  main();
}

module.exports = {
  collectThemes,
  collectDreamThemes,
  collectHyperCreativeThemes,
  mergeEvidenceRows,
  passGate,
  runCmd,
  statusCmd
};
export {};
