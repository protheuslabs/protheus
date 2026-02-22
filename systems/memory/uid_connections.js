#!/usr/bin/env node
'use strict';

/**
 * systems/memory/uid_connections.js
 *
 * Builds deterministic uid-to-uid connection graph from memory pointers.
 * Emits adaptive-memory candidate suggestions (proposed only).
 *
 * Usage:
 *   node systems/memory/uid_connections.js build [YYYY-MM-DD] [--days=7] [--top=200]
 *   node systems/memory/uid_connections.js status [YYYY-MM-DD]
 *   node systems/memory/uid_connections.js --help
 */

const fs = require('fs');
const path = require('path');
const { stableUid, isAlnum } = require('../../lib/uid.js');
const { enforceMutationProvenance, recordMutationAudit } = require('../../lib/mutation_provenance.js');

const SCRIPT_SOURCE = 'systems/memory/uid_connections.js';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const EYES_POINTERS_DIR = process.env.UID_CONNECTIONS_EYES_POINTERS_DIR
  ? path.resolve(String(process.env.UID_CONNECTIONS_EYES_POINTERS_DIR))
  : path.join(REPO_ROOT, 'state', 'memory', 'eyes_pointers');
const ADAPTIVE_POINTERS_PATH = process.env.UID_CONNECTIONS_ADAPTIVE_POINTERS_PATH
  ? path.resolve(String(process.env.UID_CONNECTIONS_ADAPTIVE_POINTERS_PATH))
  : path.join(REPO_ROOT, 'state', 'memory', 'adaptive_pointers.jsonl');
const CONNECTIONS_PATH = process.env.UID_CONNECTIONS_LOG_PATH
  ? path.resolve(String(process.env.UID_CONNECTIONS_LOG_PATH))
  : path.join(REPO_ROOT, 'state', 'memory', 'uid_connections.jsonl');
const CONNECTION_INDEX_PATH = process.env.UID_CONNECTIONS_INDEX_PATH
  ? path.resolve(String(process.env.UID_CONNECTIONS_INDEX_PATH))
  : path.join(REPO_ROOT, 'state', 'memory', 'uid_connection_index.json');
const SUGGESTIONS_DIR = process.env.UID_CONNECTIONS_SUGGESTIONS_DIR
  ? path.resolve(String(process.env.UID_CONNECTIONS_SUGGESTIONS_DIR))
  : path.join(REPO_ROOT, 'state', 'adaptive', 'suggestions');

const DEFAULT_DAYS = clampInt(process.env.UID_CONNECTIONS_DAYS || 7, 1, 30);
const DEFAULT_TOP = clampInt(process.env.UID_CONNECTIONS_TOP || 200, 20, 600);
const SHARED_TAG_MIN = clampInt(process.env.UID_CONNECTIONS_SHARED_TAG_MIN || 1, 1, 4);
const SUGGESTION_MIN_CONNECTIONS = clampInt(process.env.UID_CONNECTIONS_SUGGESTION_MIN_CONNECTIONS || 2, 1, 8);

const NOISE_TAGS = new Set([
  'adaptive', 'eyes', 'sensory', 'memory', 'system', 'active', 'proposed', 'unknown'
]);

function usage() {
  console.log('Usage:');
  console.log('  node systems/memory/uid_connections.js build [YYYY-MM-DD] [--days=7] [--top=200]');
  console.log('  node systems/memory/uid_connections.js status [YYYY-MM-DD]');
  console.log('  node systems/memory/uid_connections.js --help');
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
  const s = String(v || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return new Date().toISOString().slice(0, 10);
}

function nowIso() {
  return new Date().toISOString();
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

function appendJsonl(filePath, rows) {
  ensureDir(path.dirname(filePath));
  for (const row of rows) {
    fs.appendFileSync(filePath, JSON.stringify(row) + '\n', 'utf8');
  }
}

function normalizeTag(v) {
  return String(v || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
}

function toDateOnly(v) {
  const s = String(v || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const ms = Date.parse(s);
  if (Number.isFinite(ms)) return new Date(ms).toISOString().slice(0, 10);
  return null;
}

function windowDates(dateStr, days) {
  const out = [];
  const end = new Date(`${dateStr}T12:00:00.000Z`);
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(end);
    d.setUTCDate(d.getUTCDate() - i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

function ensureUid(value, seed) {
  const raw = String(value || '').trim();
  if (raw && isAlnum(raw)) return raw;
  return stableUid(String(seed || ''), { prefix: 'u', length: 24 });
}

function loadPointerRows(dateStr, days, top) {
  const dates = windowDates(dateStr, days);
  const dateSet = new Set(dates);
  const rows = [];

  for (const d of dates) {
    const fp = path.join(EYES_POINTERS_DIR, `${d}.jsonl`);
    const raw = readJsonlSafe(fp);
    for (const r of raw) {
      const uid = ensureUid(r && r.uid, `${r && r.node_id}|${r && r.item_hash}|${r && r.proposal_id}`);
      const topics = Array.isArray(r && r.topics) ? r.topics : [];
      const eyeTag = normalizeTag(r && r.eye_id || 'eyes');
      const tags = Array.from(new Set([...topics.map(normalizeTag), eyeTag, 'eyes', 'sensory'])).filter(Boolean);
      rows.push({
        uid,
        source: 'eyes',
        layer: 'sensory',
        id: String(r && r.proposal_id || ''),
        title: String(r && r.title || ''),
        tags,
        date: d
      });
    }
  }

  const adaptiveRows = readJsonlSafe(ADAPTIVE_POINTERS_PATH);
  for (const r of adaptiveRows) {
    const d = toDateOnly(r && r.ts);
    if (!d || !dateSet.has(d)) continue;
    const uid = ensureUid(r && r.uid, `${r && r.path_ref}|${r && r.entity_id}`);
    const tags = Array.isArray(r && r.tags) ? r.tags.map(normalizeTag) : [];
    rows.push({
      uid,
      source: 'adaptive',
      layer: normalizeTag(r && r.layer || 'adaptive'),
      id: String(r && r.entity_id || ''),
      title: String(r && r.summary || ''),
      tags: Array.from(new Set(['adaptive', ...tags])).filter(Boolean),
      date: d
    });
  }

  const uniq = new Map();
  for (const row of rows) {
    const key = `${row.uid}|${row.source}|${row.id}`;
    if (!uniq.has(key)) uniq.set(key, row);
  }
  return Array.from(uniq.values()).slice(0, top);
}

function sharedTags(a, b) {
  const aset = new Set((a.tags || []).filter((t) => !NOISE_TAGS.has(t)));
  const out = [];
  for (const t of (b.tags || [])) {
    if (!NOISE_TAGS.has(t) && aset.has(t) && !out.includes(t)) out.push(t);
  }
  out.sort();
  return out;
}

function confidence(sharedCount, sameLayer, crossSource) {
  let n = 35 + sharedCount * 18;
  if (sameLayer) n += 8;
  if (crossSource) n += 10;
  return Math.max(1, Math.min(99, Math.round(n)));
}

function connectionKey(srcUid, dstUid, relation) {
  const ids = [String(srcUid || ''), String(dstUid || '')].sort();
  return `${ids[0]}|${ids[1]}|${relation}`;
}

function loadConnectionIndex() {
  const base = readJsonSafe(CONNECTION_INDEX_PATH, { version: '1.0', keys: {} });
  if (!base || typeof base !== 'object') return { version: '1.0', keys: {} };
  if (!base.keys || typeof base.keys !== 'object') base.keys = {};
  return base;
}

function saveConnectionIndex(index) {
  ensureDir(path.dirname(CONNECTION_INDEX_PATH));
  fs.writeFileSync(CONNECTION_INDEX_PATH, JSON.stringify({
    version: '1.0',
    updated_ts: nowIso(),
    keys: index && index.keys && typeof index.keys === 'object' ? index.keys : {}
  }, null, 2) + '\n', 'utf8');
}

function buildConnections(rows, dateStr) {
  const index = loadConnectionIndex();
  const out = [];

  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const a = rows[i];
      const b = rows[j];
      if (!a.uid || !b.uid || a.uid === b.uid) continue;
      const shared = sharedTags(a, b);
      if (shared.length < SHARED_TAG_MIN) continue;
      const relation = 'thematic_overlap';
      const key = connectionKey(a.uid, b.uid, relation);
      if (index.keys[key]) continue;
      const row = {
        ts: nowIso(),
        date: dateStr,
        uid: stableUid(`conn|${key}|${dateStr}`, { prefix: 'c', length: 24 }),
        src_uid: a.uid,
        dst_uid: b.uid,
        relation,
        status: 'proposed',
        source_mode: 'active',
        source_system: 'uid_connections',
        shared_tags: shared,
        confidence: confidence(shared.length, a.layer === b.layer, a.source !== b.source),
        src_layer: a.layer,
        dst_layer: b.layer
      };
      out.push(row);
      index.keys[key] = row.uid;
    }
  }

  saveConnectionIndex(index);
  return out;
}

function buildAdaptiveSuggestions(rows, connections, dateStr) {
  const byTag = new Map();
  const adaptiveTags = new Set();
  for (const r of rows) {
    if (r.source === 'adaptive') {
      for (const t of r.tags || []) adaptiveTags.add(t);
    }
  }
  for (const c of connections) {
    for (const t of c.shared_tags || []) {
      if (!byTag.has(t)) byTag.set(t, { tag: t, connections: [], uids: new Set() });
      const bucket = byTag.get(t);
      bucket.connections.push(c);
      bucket.uids.add(String(c.src_uid || ''));
      bucket.uids.add(String(c.dst_uid || ''));
    }
  }

  const suggestions = [];
  for (const bucket of byTag.values()) {
    if (adaptiveTags.has(bucket.tag)) continue;
    if (bucket.connections.length < SUGGESTION_MIN_CONNECTIONS) continue;
    const uids = Array.from(bucket.uids).filter(Boolean).slice(0, 10);
    const id = `ADP${stableUid(`adaptive_suggestion|${bucket.tag}|${dateStr}`, { prefix: 's', length: 20 })}`;
    suggestions.push({
      id,
      uid: stableUid(`adaptive_suggestion_uid|${bucket.tag}|${dateStr}`, { prefix: 's', length: 24 }),
      type: 'adaptive_memory_candidate',
      status: 'proposed',
      date: dateStr,
      title: `Consider adaptive memory for theme: ${bucket.tag}`,
      theme_tag: bucket.tag,
      relation_count: bucket.connections.length,
      evidence_uids: uids,
      recommended_layer: 'sensory',
      suggested_controller: 'systems/sensory/eyes_intake.js',
      suggested_action: `Evaluate whether a new adaptive eye or adaptive strategy artifact is warranted for theme '${bucket.tag}'.`
    });
  }

  suggestions.sort((a, b) => {
    if (b.relation_count !== a.relation_count) return b.relation_count - a.relation_count;
    return String(a.theme_tag).localeCompare(String(b.theme_tag));
  });

  if (suggestions.length === 0) return { added: 0, file: null };
  ensureDir(SUGGESTIONS_DIR);
  const fp = path.join(SUGGESTIONS_DIR, `${dateStr}.json`);
  const existing = readJsonSafe(fp, []);
  const arr = Array.isArray(existing) ? existing.slice() : [];
  const seen = new Set(arr.map((x) => String(x && x.id || '')).filter(Boolean));
  let added = 0;
  for (const s of suggestions) {
    if (seen.has(s.id)) continue;
    arr.push(s);
    seen.add(s.id);
    added++;
  }
  fs.writeFileSync(fp, JSON.stringify(arr, null, 2) + '\n', 'utf8');
  return { added, file: path.relative(REPO_ROOT, fp).replace(/\\/g, '/') };
}

function cmdBuild(dateStr, days, top) {
  const provenance = enforceMutationProvenance('memory', {
    source: SCRIPT_SOURCE,
    reason: 'uid_connections_build'
  }, {
    fallbackSource: SCRIPT_SOURCE,
    defaultReason: 'uid_connections_build',
    context: `build:${dateStr}`
  });
  const rows = loadPointerRows(dateStr, days, top);
  const connections = buildConnections(rows, dateStr);
  appendJsonl(CONNECTIONS_PATH, connections);
  const suggestions = buildAdaptiveSuggestions(rows, connections, dateStr);
  const out = {
    ok: true,
    type: 'uid_connections_build',
    date: dateStr,
    days,
    pointers_considered: rows.length,
    new_connections: connections.length,
    new_adaptive_suggestions: suggestions.added,
    adaptive_suggestions_file: suggestions.file
  };
  recordMutationAudit('memory', {
    type: 'controller_run',
    controller: SCRIPT_SOURCE,
    operation: 'uid_connections_build',
    source: provenance.meta && provenance.meta.source || SCRIPT_SOURCE,
    reason: provenance.meta && provenance.meta.reason || 'uid_connections_build',
    provenance_ok: provenance.ok === true,
    provenance_violations: Array.isArray(provenance.violations) ? provenance.violations : [],
    files_touched: [
      path.relative(REPO_ROOT, CONNECTIONS_PATH).replace(/\\/g, '/'),
      path.relative(REPO_ROOT, CONNECTION_INDEX_PATH).replace(/\\/g, '/'),
      out.adaptive_suggestions_file
    ].filter(Boolean),
    metrics: {
      pointers_considered: out.pointers_considered,
      new_connections: out.new_connections,
      new_adaptive_suggestions: out.new_adaptive_suggestions
    }
  });
  return out;
}

function cmdStatus(dateStr) {
  const rows = readJsonlSafe(CONNECTIONS_PATH).filter((r) => String(r && r.date || '') === String(dateStr));
  const suggestionFile = path.join(SUGGESTIONS_DIR, `${dateStr}.json`);
  const suggestions = readJsonSafe(suggestionFile, []);
  return {
    ok: true,
    type: 'uid_connections_status',
    date: dateStr,
    connections_today: rows.length,
    suggestions_today: Array.isArray(suggestions) ? suggestions.length : 0,
    connections_file: fs.existsSync(CONNECTIONS_PATH) ? path.relative(REPO_ROOT, CONNECTIONS_PATH).replace(/\\/g, '/') : null,
    suggestions_file: fs.existsSync(suggestionFile) ? path.relative(REPO_ROOT, suggestionFile).replace(/\\/g, '/') : null
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').toLowerCase();
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'build') {
    const dateStr = toDate(args._[1]);
    const days = clampInt(args.days == null ? DEFAULT_DAYS : args.days, 1, 30);
    const top = clampInt(args.top == null ? DEFAULT_TOP : args.top, 20, 600);
    process.stdout.write(JSON.stringify(cmdBuild(dateStr, days, top)) + '\n');
    return;
  }
  if (cmd === 'status') {
    const dateStr = toDate(args._[1]);
    process.stdout.write(JSON.stringify(cmdStatus(dateStr)) + '\n');
    return;
  }
  usage();
  process.exit(2);
}

if (require.main === module) {
  main();
}

module.exports = {
  loadPointerRows,
  buildConnections,
  buildAdaptiveSuggestions,
  cmdBuild,
  cmdStatus
};
