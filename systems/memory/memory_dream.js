#!/usr/bin/env node
'use strict';

/**
 * systems/memory/memory_dream.js
 *
 * Deterministic low-cost memory exploration pass based on eyes->memory pointers.
 * Produces a compact "dream sheet" with cross-signal connections.
 *
 * Usage:
 *   node systems/memory/memory_dream.js run [YYYY-MM-DD] [--days=3] [--top=6]
 *   node systems/memory/memory_dream.js status [YYYY-MM-DD]
 *   node systems/memory/memory_dream.js --help
 */

const fs = require('fs');
const path = require('path');
const { enforceMutationProvenance, recordMutationAudit } = require('../../lib/mutation_provenance.js');

const SCRIPT_SOURCE = 'systems/memory/memory_dream.js';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const POINTERS_DIR = process.env.MEMORY_DREAM_POINTERS_DIR
  ? path.resolve(String(process.env.MEMORY_DREAM_POINTERS_DIR))
  : path.join(REPO_ROOT, 'state', 'memory', 'eyes_pointers');
const FAILURE_POINTERS_DIR = process.env.MEMORY_DREAM_FAILURE_POINTERS_DIR
  ? path.resolve(String(process.env.MEMORY_DREAM_FAILURE_POINTERS_DIR))
  : path.join(REPO_ROOT, 'state', 'memory', 'failure_pointers');
const ADAPTIVE_POINTERS_PATH = process.env.MEMORY_DREAM_ADAPTIVE_POINTERS_PATH
  ? path.resolve(String(process.env.MEMORY_DREAM_ADAPTIVE_POINTERS_PATH))
  : path.join(REPO_ROOT, 'state', 'memory', 'adaptive_pointers.jsonl');
const MEMORY_INDEX_PATH = process.env.MEMORY_DREAM_MEMORY_INDEX_PATH
  ? path.resolve(String(process.env.MEMORY_DREAM_MEMORY_INDEX_PATH))
  : path.join(REPO_ROOT, 'memory', 'MEMORY_INDEX.md');
const DREAMS_DIR = process.env.MEMORY_DREAM_OUTPUT_DIR
  ? path.resolve(String(process.env.MEMORY_DREAM_OUTPUT_DIR))
  : path.join(REPO_ROOT, 'state', 'memory', 'dreams');
const DREAM_LEDGER_PATH = process.env.MEMORY_DREAM_LEDGER_PATH
  ? path.resolve(String(process.env.MEMORY_DREAM_LEDGER_PATH))
  : path.join(DREAMS_DIR, 'dream_runs.jsonl');

const DEFAULT_DAYS = clampInt(process.env.MEMORY_DREAM_DAYS || 3, 1, 14);
const DEFAULT_TOP = clampInt(process.env.MEMORY_DREAM_TOP || 6, 1, 16);
const DEFAULT_OLDER_PER_THEME = clampInt(process.env.MEMORY_DREAM_OLDER_PER_THEME || 2, 1, 8);
const DEFAULT_OLDER_TOTAL = clampInt(process.env.MEMORY_DREAM_OLDER_TOTAL || 12, 1, 40);

const STOPWORDS = new Set([
  'about', 'above', 'after', 'again', 'against', 'agent', 'agents', 'also', 'and', 'any', 'are', 'around',
  'because', 'been', 'before', 'being', 'below', 'between', 'build', 'can', 'could', 'data', 'does', 'done',
  'eyes', 'from', 'have', 'into', 'just', 'more', 'most', 'need', 'only', 'other', 'over', 'same', 'should',
  'signal', 'signals', 'some', 'still', 'system', 'that', 'their', 'them', 'then', 'there', 'these', 'they',
  'this', 'those', 'through', 'today', 'using', 'very', 'were', 'what', 'when', 'where', 'which', 'while',
  'with', 'would', 'your'
]);

function usage() {
  console.log('Usage:');
  console.log('  node systems/memory/memory_dream.js run [YYYY-MM-DD] [--days=3] [--top=6]');
  console.log('  node systems/memory/memory_dream.js status [YYYY-MM-DD]');
  console.log('  node systems/memory/memory_dream.js --help');
}

function parseArgs(argv) {
  const out = { _: [] };
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

function toDate(v) {
  const raw = String(v || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  return new Date().toISOString().slice(0, 10);
}

function nowIso() {
  return new Date().toISOString();
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function appendJsonl(filePath, obj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, JSON.stringify(obj) + '\n', 'utf8');
}

function safeReadJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

function dateDaysBack(endDateStr, days) {
  const out = [];
  const end = new Date(`${endDateStr}T12:00:00.000Z`);
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(end);
    d.setUTCDate(d.getUTCDate() - i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

function toDateOnly(v) {
  const raw = String(v || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const ms = Date.parse(raw);
  if (Number.isFinite(ms)) return new Date(ms).toISOString().slice(0, 10);
  return null;
}

function tokenizeText(v) {
  return String(v || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 4)
    .filter((t) => !STOPWORDS.has(t))
    .slice(0, 32);
}

function normalizeToken(v) {
  return String(v || '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function safeReadText(filePath) {
  try {
    if (!fs.existsSync(filePath)) return '';
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function normalizeHeaderCell(v) {
  const s = String(v || '').trim().toLowerCase().replace(/[^\w]+/g, '_');
  if (s.includes('node_id')) return 'node_id';
  if (s === 'file' || s.startsWith('file_')) return 'file';
  if (s.startsWith('summary') || s.startsWith('title')) return 'summary';
  if (s.startsWith('tags')) return 'tags';
  return s;
}

function parseTagsCell(v) {
  return Array.from(new Set(
    String(v || '')
      .split(/[\s,]+/)
      .map((t) => String(t || '').trim().replace(/^#+/, ''))
      .map(normalizeToken)
      .filter(Boolean)
  ));
}

function parseMemoryIndexEntries(filePath) {
  const text = safeReadText(filePath);
  if (!text) return [];
  const lines = text.split('\n');
  const entries = [];
  let headers = null;
  for (const raw of lines) {
    const line = String(raw || '').trim();
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1).map((c) => String(c || '').trim());
    if (!cells.length) continue;
    if (cells.every((c) => /^[-: ]+$/.test(c))) continue;
    const normalized = cells.map(normalizeHeaderCell);
    if (normalized.includes('node_id') && normalized.includes('file')) {
      headers = normalized;
      continue;
    }
    if (!headers) continue;
    const row = {};
    for (let i = 0; i < headers.length; i++) row[headers[i]] = String(cells[i] || '').trim();
    const nodeId = String(row.node_id || '').replace(/`/g, '').trim();
    const file = String(row.file || '').replace(/`/g, '').trim();
    if (!nodeId || !file) continue;
    const summary = String(row.summary || '').replace(/`/g, '').trim();
    entries.push({
      node_id: nodeId,
      file,
      summary,
      tags: parseTagsCell(row.tags || '')
    });
  }
  return entries;
}

function dateFromFileRef(fileRef) {
  const m = String(fileRef || '').match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

function enrichThemesWithOlderMemory(themes, rows, recentDates) {
  if (!Array.isArray(themes) || themes.length === 0) return { themes: [], older_links_total: 0 };
  const indexEntries = parseMemoryIndexEntries(MEMORY_INDEX_PATH);
  if (!indexEntries.length) return { themes, older_links_total: 0 };

  const recentNodeIds = new Set(rows.map((r) => String(r && r.node_id || '')).filter(Boolean));
  const oldestRecent = Array.isArray(recentDates) && recentDates.length ? recentDates[0] : null;
  const usedKeys = new Set();
  let olderLinksTotal = 0;

  const nextThemes = themes.map((theme) => ({ ...theme, older_refs: [] }));
  for (const theme of nextThemes) {
    if (olderLinksTotal >= DEFAULT_OLDER_TOTAL) break;
    const token = normalizeToken(theme && theme.token);
    if (!token) continue;

    const candidates = [];
    for (const ent of indexEntries) {
      const key = `${ent.file}#${ent.node_id}`;
      if (usedKeys.has(key)) continue;
      if (recentNodeIds.has(String(ent.node_id || ''))) continue;
      const entryDate = dateFromFileRef(ent.file);
      if (oldestRecent && entryDate && entryDate >= oldestRecent) continue;

      let score = 0;
      if (ent.tags.includes(token)) score += 8;
      if (String(ent.summary || '').toLowerCase().includes(token)) score += 3;
      if (String(ent.node_id || '').toLowerCase().includes(token)) score += 2;
      if (score <= 0) continue;
      candidates.push({
        node_id: ent.node_id,
        file: ent.file,
        summary: String(ent.summary || '').slice(0, 140),
        score
      });
    }

    candidates.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const ad = dateFromFileRef(a.file) || '';
      const bd = dateFromFileRef(b.file) || '';
      if (bd !== ad) return bd.localeCompare(ad);
      return String(a.node_id).localeCompare(String(b.node_id));
    });

    const take = Math.max(0, Math.min(DEFAULT_OLDER_PER_THEME, DEFAULT_OLDER_TOTAL - olderLinksTotal));
    const picked = candidates.slice(0, take);
    for (const p of picked) {
      const key = `${p.file}#${p.node_id}`;
      usedKeys.add(key);
    }
    theme.older_refs = picked;
    olderLinksTotal += picked.length;
  }

  return { themes: nextThemes, older_links_total: olderLinksTotal };
}

function themeRows(rows) {
  const themes = new Map();

  for (const row of rows) {
    const topicTokens = Array.isArray(row && row.topics) ? row.topics.map((t) => String(t || '').toLowerCase()) : [];
    const titleTokens = tokenizeText(row && row.title);
    const tokens = Array.from(new Set([...topicTokens, ...titleTokens])).filter(Boolean).slice(0, 16);
    for (const tok of tokens) {
      if (!themes.has(tok)) {
        themes.set(tok, {
          token: tok,
          rows: [],
          eye_ids: new Set(),
          node_ids: new Set(),
          failure_count: 0,
          failure_tier_min: null
        });
      }
      const ent = themes.get(tok);
      ent.rows.push(row);
      if (row && row.eye_id) ent.eye_ids.add(String(row.eye_id));
      if (row && row.node_id) ent.node_ids.add(String(row.node_id));
      const rowTier = Number(row && row.failure_tier);
      if (Number.isFinite(rowTier) && rowTier >= 1) {
        ent.failure_count += 1;
        ent.failure_tier_min = ent.failure_tier_min == null
          ? rowTier
          : Math.min(Number(ent.failure_tier_min || 3), rowTier);
      }
    }
  }

  const out = [];
  for (const ent of themes.values()) {
    const occurrenceCount = ent.rows.length;
    const eyeDiversity = ent.eye_ids.size;
    const nodeDiversity = ent.node_ids.size;
    if (occurrenceCount < 2) continue;
    if (eyeDiversity < 2 && occurrenceCount < 3) continue;
    const failureCount = Number(ent.failure_count || 0);
    const failureTierMin = Number.isFinite(Number(ent.failure_tier_min)) ? Number(ent.failure_tier_min) : null;
    const failureTierBoost = failureTierMin == null ? 0 : Math.max(0, (4 - Math.max(1, Math.min(3, failureTierMin))) * 4);
    const score = occurrenceCount * 3 + eyeDiversity * 5 + nodeDiversity * 2 + failureCount * 3 + failureTierBoost;
    out.push({
      token: ent.token,
      score,
      occurrence_count: occurrenceCount,
      eye_diversity: eyeDiversity,
      node_diversity: nodeDiversity,
      failure_count: failureCount,
      failure_tier_min: failureTierMin,
      rows: ent.rows.slice(0, 8)
    });
  }

  out.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return String(a.token).localeCompare(String(b.token));
  });
  return out;
}

function renderDreamMarkdown(dateStr, days, rows, themes) {
  const uniqueEyes = Array.from(new Set(rows.map((r) => String(r.eye_id || '')).filter(Boolean))).sort();
  const failureRows = rows.filter((r) => Number.isFinite(Number(r && r.failure_tier)));
  const lines = [
    `# Memory Dream Sheet: ${dateStr}`,
    '',
    `Generated: ${nowIso()}`,
    '',
    '## Inputs',
    '',
    `- Pointer rows: ${rows.length}`,
    `- Distinct eyes: ${uniqueEyes.length}`,
    `- Failure pointers: ${failureRows.length}`,
    `- Window: last ${days} day(s)`,
    ''
  ];

  if (!themes.length) {
    lines.push('## Themes', '', '- No cross-signal themes met threshold today.', '');
    return lines.join('\n');
  }

  lines.push('## Themes', '');
  for (const t of themes) {
    lines.push(`### ${t.token}`);
    lines.push(`- Score: ${t.score} (occurrences=${t.occurrence_count}, eye_diversity=${t.eye_diversity})`);
    if (Number(t.failure_count || 0) > 0) {
      lines.push(`- Failure-linked: count=${Number(t.failure_count || 0)}, tier_min=${Number(t.failure_tier_min || 3)}`);
    }
    lines.push('- Memory refs:');
    for (const r of t.rows.slice(0, 4)) {
      const file = String(r.memory_file || 'memory/unknown.md');
      const nodeId = String(r.node_id || 'unknown-node');
      const title = String(r.title || '').slice(0, 120);
      lines.push(`  - ${file}#${nodeId} :: ${title}`);
    }
    if (Array.isArray(t.older_refs) && t.older_refs.length > 0) {
      lines.push('- Older memory echoes:');
      for (const older of t.older_refs) {
        const file = String(older.file || 'memory/unknown.md');
        const nodeId = String(older.node_id || 'unknown-node');
        const summary = String(older.summary || '').slice(0, 120);
        lines.push(`  - ${file}#${nodeId} :: ${summary}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

function runDream(dateStr, days, top) {
  const provenance = enforceMutationProvenance('memory', {
    source: SCRIPT_SOURCE,
    reason: 'memory_dream_run'
  }, {
    fallbackSource: SCRIPT_SOURCE,
    defaultReason: 'memory_dream_run',
    context: `run:${dateStr}`
  });
  const dates = dateDaysBack(dateStr, days);
  const dateSet = new Set(dates);
  const rows = [];
  for (const d of dates) {
    const fp = path.join(POINTERS_DIR, `${d}.jsonl`);
    rows.push(...safeReadJsonl(fp).map((r) => ({ ...r, pointer_date: d })));
  }
  const adaptiveRows = safeReadJsonl(ADAPTIVE_POINTERS_PATH)
    .map((r) => {
      const d = toDateOnly(r && r.ts);
      return {
        pointer_date: d,
        uid: r && r.uid ? String(r.uid) : null,
        node_id: r && r.entity_id ? String(r.entity_id) : `adaptive-${String(r && r.uid || '').slice(0, 8)}`,
        memory_file: r && r.path_ref ? String(r.path_ref) : 'adaptive/unknown',
        eye_id: r && r.layer ? `adaptive_${String(r.layer)}` : 'adaptive',
        title: r && r.summary ? String(r.summary) : 'Adaptive pointer',
        topics: Array.isArray(r && r.tags) ? r.tags : []
      };
    })
    .filter((r) => r.pointer_date && dateSet.has(r.pointer_date));
  rows.push(...adaptiveRows);
  const failureRows = [];
  for (const d of dates) {
    const fp = path.join(FAILURE_POINTERS_DIR, `${d}.jsonl`);
    const parsed = safeReadJsonl(fp);
    for (const r of parsed) {
      const tierRaw = Number(r && (r.failure_tier != null ? r.failure_tier : r.tier));
      const failureTier = Number.isFinite(tierRaw) ? Math.max(1, Math.min(3, Math.round(tierRaw))) : null;
      const topics = Array.isArray(r && r.topics) ? r.topics : [];
      failureRows.push({
        pointer_date: d,
        uid: r && r.uid ? String(r.uid) : null,
        node_id: r && r.node_id ? String(r.node_id) : `failure-${String(r && r.item_hash || '').slice(0, 8)}`,
        memory_file: r && r.memory_file ? String(r.memory_file) : 'memory/unknown.md',
        eye_id: `failure_tier_${failureTier || 3}`,
        title: r && r.title ? String(r.title) : 'Failure pointer',
        topics: Array.from(new Set([
          'failure',
          failureTier ? `failure-tier-${failureTier}` : '',
          ...topics.map((t) => String(t || ''))
        ].filter(Boolean))),
        failure_tier: failureTier
      });
    }
  }
  rows.push(...failureRows);
  const baseThemes = themeRows(rows).slice(0, top);
  const enriched = enrichThemesWithOlderMemory(baseThemes, rows, dates);
  const themes = enriched.themes;

  ensureDir(DREAMS_DIR);
  const mdPath = path.join(DREAMS_DIR, `${dateStr}.md`);
  const jsonPath = path.join(DREAMS_DIR, `${dateStr}.json`);

  const md = renderDreamMarkdown(dateStr, days, rows, themes);
  fs.writeFileSync(mdPath, md + '\n', 'utf8');
  fs.writeFileSync(jsonPath, JSON.stringify({
    ts: nowIso(),
    date: dateStr,
    days,
    pointer_rows: rows.length,
    failure_pointer_rows: failureRows.length,
    older_links_total: enriched.older_links_total,
    themes
  }, null, 2) + '\n', 'utf8');

  const result = {
    ok: true,
    type: 'memory_dream',
    date: dateStr,
    days,
    pointer_rows: rows.length,
    failure_pointer_rows: failureRows.length,
    themes: themes.length,
    older_links_total: Number(enriched.older_links_total || 0),
    markdown_path: path.relative(REPO_ROOT, mdPath).replace(/\\/g, '/'),
    json_path: path.relative(REPO_ROOT, jsonPath).replace(/\\/g, '/')
  };

  appendJsonl(DREAM_LEDGER_PATH, {
    ts: nowIso(),
    type: 'memory_dream_run',
    date: dateStr,
    days,
    pointer_rows: rows.length,
    failure_pointer_rows: failureRows.length,
    themes: themes.length,
    older_links_total: Number(enriched.older_links_total || 0)
  });

  recordMutationAudit('memory', {
    type: 'controller_run',
    controller: SCRIPT_SOURCE,
    operation: 'memory_dream_run',
    source: provenance.meta && provenance.meta.source || SCRIPT_SOURCE,
    reason: provenance.meta && provenance.meta.reason || 'memory_dream_run',
    provenance_ok: provenance.ok === true,
    provenance_violations: Array.isArray(provenance.violations) ? provenance.violations : [],
    files_touched: [
      result.markdown_path,
      result.json_path,
      path.relative(REPO_ROOT, DREAM_LEDGER_PATH).replace(/\\/g, '/')
    ].filter(Boolean),
    metrics: {
      days: result.days,
      pointer_rows: result.pointer_rows,
      failure_pointer_rows: result.failure_pointer_rows,
      themes: result.themes,
      older_links_total: result.older_links_total
    }
  });

  return result;
}

function status(dateStr) {
  const fp = path.join(DREAMS_DIR, `${dateStr}.json`);
  if (!fs.existsSync(fp)) {
    return { ok: true, type: 'memory_dream_status', date: dateStr, exists: false };
  }
  let parsed = {};
  try { parsed = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch {}
  return {
    ok: true,
    type: 'memory_dream_status',
    date: dateStr,
    exists: true,
    themes: Array.isArray(parsed.themes) ? parsed.themes.length : 0,
    failure_pointer_rows: Number(parsed.failure_pointer_rows || 0),
    older_links_total: Number(parsed.older_links_total || 0),
    pointer_rows: Number(parsed.pointer_rows || 0),
    json_path: path.relative(REPO_ROOT, fp).replace(/\\/g, '/'),
    markdown_path: path.relative(REPO_ROOT, path.join(DREAMS_DIR, `${dateStr}.md`)).replace(/\\/g, '/')
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').toLowerCase();
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'run') {
    const dateStr = toDate(args._[1]);
    const days = clampInt(args.days == null ? DEFAULT_DAYS : args.days, 1, 14);
    const top = clampInt(args.top == null ? DEFAULT_TOP : args.top, 1, 16);
    process.stdout.write(JSON.stringify(runDream(dateStr, days, top)) + '\n');
    return;
  }
  if (cmd === 'status') {
    const dateStr = toDate(args._[1]);
    process.stdout.write(JSON.stringify(status(dateStr)) + '\n');
    return;
  }
  usage();
  process.exit(2);
}

if (require.main === module) {
  main();
}

module.exports = {
  runDream,
  status,
  tokenizeText,
  themeRows,
  parseMemoryIndexEntries,
  enrichThemesWithOlderMemory
};
