#!/usr/bin/env node
'use strict';

/**
 * systems/adaptive/reflex/reflex_runtime_sync.js
 *
 * Mirrors adaptive reflex routines into runtime registry consumed by
 * systems/reflex/reflex_dispatcher.js.
 *
 * Safety:
 * - Only manages routines tagged with adaptive_reflex_sync.
 * - Does not mutate adaptive storage directly.
 */

const fs = require('fs');
const path = require('path');
const { readReflexState } = require('./reflex_store');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const RUNTIME_PATH = process.env.REFLEX_RUNTIME_ROUTINES_PATH
  ? path.resolve(String(process.env.REFLEX_RUNTIME_ROUTINES_PATH))
  : path.join(ROOT, 'state', 'adaptive', 'reflex', 'routines.json');
const LOG_PATH = process.env.REFLEX_RUNTIME_SYNC_LOG_PATH
  ? path.resolve(String(process.env.REFLEX_RUNTIME_SYNC_LOG_PATH))
  : path.join(ROOT, 'state', 'adaptive', 'reflex', 'runtime_sync.jsonl');
const VERSION = 1;
const MANAGED_TAG = 'adaptive_reflex_sync';

function nowIso() {
  return new Date().toISOString();
}

function normalizeId(v, maxLen = 80) {
  return String(v || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9:_-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, maxLen);
}

function clean(v, maxLen = 240) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function appendJsonl(filePath, row) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, JSON.stringify(row) + '\n', 'utf8');
}

function defaultRuntimeRegistry() {
  return {
    version: VERSION,
    updated_at: nowIso(),
    routines: {}
  };
}

function loadRuntimeRegistry() {
  const raw = readJsonSafe(RUNTIME_PATH, null);
  if (!raw || typeof raw !== 'object') return defaultRuntimeRegistry();
  const routines = raw.routines && typeof raw.routines === 'object' ? raw.routines : {};
  return {
    version: VERSION,
    updated_at: String(raw.updated_at || nowIso()),
    routines
  };
}

function stableTask(row, id) {
  const trigger = clean(row && row.trigger || `pain_signal:${id}`, 120);
  const action = clean(row && row.action || `stabilize recurring failure ${id}`, 240);
  return clean(
    `Execute reflex response for ${trigger}: ${action}. Keep deterministic, bounded, and low-risk.`,
    420
  );
}

function toRuntimeRoutine(adaptiveRow, existing) {
  const id = normalizeId(adaptiveRow && (adaptiveRow.key || adaptiveRow.id));
  if (!id) return null;
  const status = String(adaptiveRow && adaptiveRow.status || '').toLowerCase() === 'disabled'
    ? 'disabled'
    : 'enabled';
  const name = clean(adaptiveRow && adaptiveRow.name || id, 160);
  const tags = Array.from(
    new Set([
      MANAGED_TAG,
      'adaptive_reflex',
      /pain_signal/i.test(String(adaptiveRow && adaptiveRow.trigger || '')) ? 'pain_response' : ''
    ].filter(Boolean))
  );
  const priority = Number(adaptiveRow && adaptiveRow.priority || 50);
  const tokens = Math.max(90, Math.min(420, Math.round(120 + (Math.max(1, Math.min(100, priority)) * 2.2))));
  return {
    uid: clean(existing && existing.uid || adaptiveRow && adaptiveRow.uid || '', 40) || null,
    id,
    status,
    task: stableTask(adaptiveRow, id),
    intent: clean(existing && existing.intent || `adaptive_reflex:${id}`, 120),
    description: name,
    demand: 1,
    headroom: 1,
    tokens_est: tokens,
    tags,
    created_by: clean(existing && existing.created_by || 'adaptive_reflex_runtime_sync', 80),
    created_at: clean(existing && existing.created_at || adaptiveRow && adaptiveRow.created_ts || nowIso(), 40),
    updated_at: nowIso(),
    use_count: Math.max(0, Number(existing && existing.use_count || 0)),
    last_run_at: existing && existing.last_run_at ? String(existing.last_run_at) : (adaptiveRow && adaptiveRow.last_run_ts ? String(adaptiveRow.last_run_ts) : null)
  };
}

function sameRoutine(a, b) {
  if (!a || !b) return false;
  const strip = (row) => ({
    id: String(row.id || ''),
    status: String(row.status || ''),
    task: String(row.task || ''),
    intent: String(row.intent || ''),
    description: String(row.description || ''),
    demand: Number(row.demand || 0),
    headroom: Number(row.headroom || 0),
    tokens_est: Number(row.tokens_est || 0),
    tags: Array.isArray(row.tags) ? row.tags.slice().sort() : [],
    created_by: String(row.created_by || ''),
    created_at: String(row.created_at || ''),
    use_count: Number(row.use_count || 0),
    last_run_at: row.last_run_at ? String(row.last_run_at) : null
  });
  return JSON.stringify(strip(a)) === JSON.stringify(strip(b));
}

function isManagedRoutine(row) {
  const tags = Array.isArray(row && row.tags) ? row.tags : [];
  return tags.includes(MANAGED_TAG);
}

function run() {
  const adaptive = readReflexState(null, null);
  const adaptiveRows = Array.isArray(adaptive && adaptive.routines) ? adaptive.routines : [];
  const runtime = loadRuntimeRegistry();
  const next = runtime && runtime.routines && typeof runtime.routines === 'object'
    ? { ...runtime.routines }
    : {};

  let created = 0;
  let updated = 0;
  let disabled = 0;
  const managedIds = new Set();

  for (const row of adaptiveRows) {
    const id = normalizeId(row && (row.key || row.id));
    if (!id) continue;
    managedIds.add(id);
    const existing = next[id] && typeof next[id] === 'object' ? { ...next[id] } : null;
    const mapped = toRuntimeRoutine(row, existing);
    if (!mapped) continue;
    if (!existing) {
      created += 1;
      next[id] = mapped;
      continue;
    }
    if (!sameRoutine(existing, mapped)) {
      updated += 1;
      next[id] = {
        ...existing,
        ...mapped
      };
    } else {
      next[id] = {
        ...existing,
        updated_at: existing.updated_at || nowIso()
      };
    }
  }

  for (const [id, row] of Object.entries(next)) {
    if (!isManagedRoutine(row)) continue;
    if (managedIds.has(id)) continue;
    if (String(row && row.status || '').toLowerCase() !== 'disabled') {
      disabled += 1;
      next[id] = {
        ...row,
        status: 'disabled',
        updated_at: nowIso()
      };
    }
  }

  const changed = created > 0 || updated > 0 || disabled > 0 || !fs.existsSync(RUNTIME_PATH);
  if (changed) {
    writeJson(RUNTIME_PATH, {
      version: VERSION,
      updated_at: nowIso(),
      routines: next
    });
  }

  const summary = {
    ok: true,
    type: 'reflex_runtime_sync',
    ts: nowIso(),
    changed,
    adaptive_routines: adaptiveRows.length,
    runtime_routines: Object.keys(next).length,
    managed_routines: Object.values(next).filter((row) => isManagedRoutine(row)).length,
    created,
    updated,
    disabled,
    runtime_path: path.relative(ROOT, RUNTIME_PATH).replace(/\\/g, '/')
  };
  appendJsonl(LOG_PATH, summary);
  return summary;
}

function status() {
  const runtime = loadRuntimeRegistry();
  const rows = Object.values(runtime.routines || {});
  return {
    ok: true,
    type: 'reflex_runtime_sync_status',
    runtime_path: path.relative(ROOT, RUNTIME_PATH).replace(/\\/g, '/'),
    total_routines: rows.length,
    managed_routines: rows.filter((row) => isManagedRoutine(row)).length
  };
}

function usage() {
  process.stdout.write(
    'Usage:\n' +
    '  node systems/adaptive/reflex/reflex_runtime_sync.js run\n' +
    '  node systems/adaptive/reflex/reflex_runtime_sync.js status\n'
  );
}

function main() {
  const cmd = String(process.argv[2] || '').trim().toLowerCase();
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    usage();
    return;
  }
  if (cmd === 'run') {
    process.stdout.write(JSON.stringify(run()) + '\n');
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
  try {
    main();
  } catch (err) {
    process.stdout.write(JSON.stringify({
      ok: false,
      error: String(err && err.message || err || 'reflex_runtime_sync_failed')
    }) + '\n');
    process.exit(1);
  }
}

module.exports = {
  run,
  status
};

