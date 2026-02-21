#!/usr/bin/env node
'use strict';

/**
 * systems/memory/idle_dream_cycle.js
 *
 * Idle dreaming with lightweight local LLM + optional REM quantization:
 * - IDLE pass: generate lightweight creative links from recent dream material.
 * - REM pass: quantize diluted idle links into tighter ranked syntheses
 *   using deterministic mode (default) or local LLM mode (optional).
 *
 * Usage:
 *   node systems/memory/idle_dream_cycle.js run [YYYY-MM-DD] [--force=1] [--rem-only=1]
 *   node systems/memory/idle_dream_cycle.js status
 *   node systems/memory/idle_dream_cycle.js --help
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { stableUid } = require('../../lib/uid.js');
const { listLocalOllamaModels, runLocalOllamaPrompt, stripAnsi } = require('../routing/llm_gateway.js');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DREAMS_DIR = process.env.IDLE_DREAM_DREAMS_DIR
  ? path.resolve(String(process.env.IDLE_DREAM_DREAMS_DIR))
  : path.join(REPO_ROOT, 'state', 'memory', 'dreams');
const IDLE_DIR = process.env.IDLE_DREAM_IDLE_DIR
  ? path.resolve(String(process.env.IDLE_DREAM_IDLE_DIR))
  : path.join(DREAMS_DIR, 'idle');
const REM_DIR = process.env.IDLE_DREAM_REM_DIR
  ? path.resolve(String(process.env.IDLE_DREAM_REM_DIR))
  : path.join(DREAMS_DIR, 'rem');
const STATE_PATH = process.env.IDLE_DREAM_STATE_PATH
  ? path.resolve(String(process.env.IDLE_DREAM_STATE_PATH))
  : path.join(DREAMS_DIR, 'idle_state.json');
const LEDGER_PATH = process.env.IDLE_DREAM_LEDGER_PATH
  ? path.resolve(String(process.env.IDLE_DREAM_LEDGER_PATH))
  : path.join(DREAMS_DIR, 'idle_runs.jsonl');
const ROUTING_DECISIONS_PATH = process.env.IDLE_DREAM_ROUTING_DECISIONS_PATH
  ? path.resolve(String(process.env.IDLE_DREAM_ROUTING_DECISIONS_PATH))
  : path.join(REPO_ROOT, 'state', 'routing', 'routing_decisions.jsonl');
const MEMORY_DREAM_SCRIPT = process.env.IDLE_DREAM_MEMORY_DREAM_SCRIPT
  ? path.resolve(String(process.env.IDLE_DREAM_MEMORY_DREAM_SCRIPT))
  : path.join(REPO_ROOT, 'systems', 'memory', 'memory_dream.js');
const SPAWN_BROKER_SCRIPT = process.env.IDLE_DREAM_SPAWN_BROKER_SCRIPT
  ? path.resolve(String(process.env.IDLE_DREAM_SPAWN_BROKER_SCRIPT))
  : path.join(REPO_ROOT, 'systems', 'spawn', 'spawn_broker.js');
const SPAWN_BUDGET_ENABLED = String(process.env.IDLE_DREAM_SPAWN_BUDGET_ENABLED || '1').trim() !== '0';
const BOOTSTRAP_MEMORY_DREAM_ENABLED = String(process.env.IDLE_DREAM_BOOTSTRAP_MEMORY_DREAM || '1').trim() !== '0';
const SPAWN_MODULE_BASE = normalizeToken(process.env.IDLE_DREAM_SPAWN_MODULE || 'dreaming') || 'dreaming';
const SPAWN_LEASE_SEC = clampInt(process.env.IDLE_DREAM_SPAWN_LEASE_SEC || 120, 15, 3600);

const IDLE_MIN_MINUTES = clampInt(process.env.IDLE_DREAM_MIN_IDLE_MINUTES || 45, 5, 24 * 60);
const REM_MIN_MINUTES = clampInt(process.env.IDLE_DREAM_REM_MIN_MINUTES || 180, 30, 7 * 24 * 60);
const REM_MIN_IDLE_RUNS = clampInt(process.env.IDLE_DREAM_REM_MIN_IDLE_RUNS || 2, 1, 50);
const WINDOW_DAYS = clampInt(process.env.IDLE_DREAM_WINDOW_DAYS || 3, 1, 14);
const MAX_SEEDS = clampInt(process.env.IDLE_DREAM_MAX_SEEDS || 10, 2, 30);
const MAX_IDLE_LINKS = clampInt(process.env.IDLE_DREAM_MAX_LINKS || 6, 1, 20);
const MAX_REM_LINKS = clampInt(process.env.IDLE_DREAM_REM_MAX_LINKS || 8, 1, 24);
const LLM_TIMEOUT_MS = clampInt(process.env.IDLE_DREAM_TIMEOUT_MS || 25000, 5000, 120000);
const REM_TIMEOUT_MS = clampInt(process.env.IDLE_DREAM_REM_TIMEOUT_MS || 30000, 5000, 150000);
const MAX_ROUTING_ROWS = clampInt(process.env.IDLE_DREAM_MAX_ROUTING_ROWS || 5000, 100, 50000);
const IDLE_REQUEST_TOKENS_EST = clampInt(process.env.IDLE_DREAM_IDLE_TOKENS_EST || 220, 50, 20000);
const REM_REQUEST_TOKENS_EST_LOCAL = clampInt(process.env.IDLE_DREAM_REM_TOKENS_EST_LOCAL || 320, 50, 20000);
const REM_REQUEST_TOKENS_EST_DETERMINISTIC = clampInt(process.env.IDLE_DREAM_REM_TOKENS_EST_DETERMINISTIC || 80, 0, 20000);
const MEMORY_DREAM_BOOTSTRAP_TIMEOUT_MS = clampInt(process.env.IDLE_DREAM_BOOTSTRAP_TIMEOUT_MS || 25000, 5000, 120000);

const IDLE_MODEL_ORDER = parseCsvOrder(
  process.env.IDLE_DREAM_MODEL_ORDER
  || 'smallthinker,qwen3:1.7b,qwen3:4b,gemma3:4b'
);
const REM_MODEL_ORDER = parseCsvOrder(
  process.env.IDLE_DREAM_REM_MODEL_ORDER
  || 'qwen3:4b,gemma3:4b,qwen3:1.7b,smallthinker'
);
const REM_STRATEGY = String(process.env.IDLE_DREAM_REM_STRATEGY || 'deterministic').trim().toLowerCase();

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'mode', 'task', 'route', 'normal', 'creative',
  'hyper', 'thinker', 'deep', 'summary', 'reason', 'model', 'tier', 'user', 'system', 'about', 'after', 'before',
  'through', 'while', 'where', 'when', 'which'
]);

function usage() {
  console.log('Usage:');
  console.log('  node systems/memory/idle_dream_cycle.js run [YYYY-MM-DD] [--force=1] [--rem-only=1]');
  console.log('  node systems/memory/idle_dream_cycle.js status');
  console.log('  node systems/memory/idle_dream_cycle.js --help');
  console.log('  env: IDLE_DREAM_REM_STRATEGY=deterministic|local (default: deterministic)');
  console.log('  env: IDLE_DREAM_SPAWN_BUDGET_ENABLED=1|0 (default: 1)');
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

function nowIso() {
  return new Date().toISOString();
}

function toDate(v) {
  const s = String(v || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return new Date().toISOString().slice(0, 10);
}

function toDateOnly(v) {
  const s = String(v || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const ms = Date.parse(s);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString().slice(0, 10);
}

function parseCsvOrder(v) {
  return String(v || '')
    .split(',')
    .map((x) => String(x || '').trim())
    .filter(Boolean);
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

function readJsonl(filePath, maxRows = null) {
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean);
  const use = maxRows == null ? lines : lines.slice(Math.max(0, lines.length - maxRows));
  const out = [];
  for (const line of use) {
    try { out.push(JSON.parse(line)); } catch {}
  }
  return out;
}

function safeJson(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch {}
  const lines = raw.split('\n').reverse();
  for (const line of lines) {
    const s = String(line || '').trim();
    if (!s.startsWith('{')) continue;
    try { return JSON.parse(s); } catch {}
  }
  return null;
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

function normalizeModelName(v) {
  const raw = String(v || '').trim().replace(/^ollama\//, '').toLowerCase();
  if (raw.endsWith(':latest')) return raw.slice(0, -(':latest'.length));
  return raw;
}

function normalizeToken(v) {
  return String(v || '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function tokenize(v) {
  return String(v || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]+/g, ' ')
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 3)
    .filter((w) => !STOPWORDS.has(w));
}

function loadState() {
  const base = readJsonSafe(STATE_PATH, null);
  if (!base || typeof base !== 'object') {
    return {
      version: '1.0',
      updated_ts: null,
      last_idle_ts: null,
      last_rem_ts: null,
      idle_runs: 0,
      rem_runs: 0,
      idle_runs_since_rem: 0,
      last_idle_model: null,
      last_rem_model: null
    };
  }
  return {
    version: '1.0',
    updated_ts: base.updated_ts || null,
    last_idle_ts: base.last_idle_ts || null,
    last_rem_ts: base.last_rem_ts || null,
    idle_runs: Number(base.idle_runs || 0),
    rem_runs: Number(base.rem_runs || 0),
    idle_runs_since_rem: Number(base.idle_runs_since_rem || 0),
    last_idle_model: base.last_idle_model || null,
    last_rem_model: base.last_rem_model || null
  };
}

function saveState(state) {
  const next = { ...state, updated_ts: nowIso() };
  writeJson(STATE_PATH, next);
}

function extractJsonObject(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        const candidate = s.slice(start, i + 1);
        try { return JSON.parse(candidate); } catch { return null; }
      }
    }
  }
  return null;
}

function listLocalModels() {
  const fake = String(process.env.IDLE_DREAM_FAKE_MODELS || '').trim();
  if (fake) return parseCsvOrder(fake).map(normalizeModelName).filter(Boolean);
  const listed = listLocalOllamaModels({
    timeoutMs: 5000,
    cwd: REPO_ROOT,
    source: 'idle_dream_cycle'
  });
  if (!listed.ok) return [];
  return Array.from(new Set((listed.models || []).map(normalizeModelName).filter(Boolean)));
}

function pickModel(order, available) {
  const normAvail = new Set((available || []).map(normalizeModelName));
  for (const m of order || []) {
    const clean = normalizeModelName(m);
    if (normAvail.has(clean)) return clean;
  }
  const list = Array.from(normAvail).sort();
  return list.length ? list[0] : null;
}

function runLocalModel(model, prompt, timeoutMs, phase) {
  const fakeIdle = String(process.env.IDLE_DREAM_FAKE_IDLE_JSON || '').trim();
  const fakeRem = String(process.env.IDLE_DREAM_FAKE_REM_JSON || '').trim();
  if (phase === 'idle' && fakeIdle) return { ok: true, stdout: fakeIdle, stderr: '', code: 0 };
  if (phase === 'rem' && fakeRem) return { ok: true, stdout: fakeRem, stderr: '', code: 0 };
  if (!model) return { ok: false, stdout: '', stderr: 'no_local_model_selected', code: 2 };
  return runLocalOllamaPrompt({
    model,
    prompt,
    timeoutMs,
    phase,
    source: 'idle_dream_cycle',
    cwd: REPO_ROOT,
    allowFlagFallback: true
  });
}

function spawnModuleName(phase) {
  const cleanPhase = normalizeToken(phase || 'idle') || 'idle';
  return `${SPAWN_MODULE_BASE}_${cleanPhase}`;
}

function spawnBrokerCall(args) {
  const r = spawnSync('node', [SPAWN_BROKER_SCRIPT, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 15000
  });
  const payload = safeJson(r.stdout);
  return {
    ok: r.status === 0 && !!payload,
    code: r.status == null ? 1 : r.status,
    payload,
    stderr: String(r.stderr || '').trim().slice(0, 220)
  };
}

function requestSpawnLease(phase, requestTokensEst) {
  if (!SPAWN_BUDGET_ENABLED) {
    return {
      ok: true,
      skipped: true,
      module: null,
      granted_cells: 1,
      reason: 'spawn_budget_disabled'
    };
  }
  const moduleName = spawnModuleName(phase);
  const req = spawnBrokerCall([
    'request',
    `--module=${moduleName}`,
    '--requested_cells=1',
    `--request_tokens_est=${Math.max(0, Math.round(Number(requestTokensEst || 0)))}`,
    `--reason=idle_dream_${normalizeToken(phase) || 'phase'}`,
    `--lease_sec=${SPAWN_LEASE_SEC}`,
    '--apply=1'
  ]);
  if (!req.ok || !req.payload) {
    return {
      ok: false,
      module: moduleName,
      reason: 'spawn_budget_unavailable',
      error: req.stderr || `spawn_request_exit_${req.code}`
    };
  }
  const granted = Math.max(0, Math.round(Number(req.payload.granted_cells || 0)));
  if (granted < 1) {
    return {
      ok: false,
      module: moduleName,
      reason: 'spawn_budget_denied',
      limits: req.payload.limits || null,
      token_budget: req.payload.token_budget || null
    };
  }
  return {
    ok: true,
    module: moduleName,
    granted_cells: granted,
    token_budget: req.payload.token_budget || null
  };
}

function releaseSpawnLease(lease, phase) {
  if (!lease || !lease.module || !SPAWN_BUDGET_ENABLED) {
    return { ok: true, skipped: true, reason: 'no_lease' };
  }
  const rel = spawnBrokerCall([
    'release',
    `--module=${lease.module}`,
    `--reason=idle_dream_${normalizeToken(phase) || 'phase'}_complete`
  ]);
  if (!rel.ok) {
    return {
      ok: false,
      reason: 'spawn_release_failed',
      error: rel.stderr || `spawn_release_exit_${rel.code}`
    };
  }
  return { ok: true, skipped: false };
}

function runMemoryDreamBootstrap(dateStr) {
  if (!BOOTSTRAP_MEMORY_DREAM_ENABLED) {
    return { ok: false, skipped: true, reason: 'memory_dream_bootstrap_disabled' };
  }
  const r = spawnSync('node', [MEMORY_DREAM_SCRIPT, 'run', dateStr], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: MEMORY_DREAM_BOOTSTRAP_TIMEOUT_MS
  });
  const payload = safeJson(r.stdout);
  if (r.status !== 0 || !payload || payload.ok !== true) {
    return {
      ok: false,
      skipped: false,
      reason: 'memory_dream_bootstrap_failed',
      code: r.status == null ? 1 : r.status,
      stderr: stripAnsi(r.stderr || '').slice(-240),
      payload: payload || null
    };
  }
  return { ok: true, skipped: false, reason: 'memory_dream_bootstrap_ok', payload };
}

function collectDreamSeeds(dateStr, days) {
  const dates = dateDaysBack(dateStr, days);
  const seeds = [];
  for (const d of dates) {
    const fp = path.join(DREAMS_DIR, `${d}.json`);
    const obj = readJsonSafe(fp, null);
    const themes = obj && Array.isArray(obj.themes) ? obj.themes : [];
    for (const t of themes.slice(0, MAX_SEEDS)) {
      const token = normalizeToken(t && t.token);
      if (!token) continue;
      seeds.push({
        token,
        score: Number(t && t.score || 0),
        source: 'memory_dream',
        refs: Array.isArray(t && t.rows)
          ? t.rows.slice(0, 3).map((r) => `${String(r.memory_file || '').slice(0, 120)}#${String(r.node_id || '').slice(0, 80)}`).filter((x) => x && !x.startsWith('#'))
          : []
      });
    }
  }
  return seeds;
}

function isHyperCreativeMode(v) {
  return String(v || '').trim().toLowerCase().replace(/_/g, '-') === 'hyper-creative';
}

function collectHyperSeeds(dateStr, days) {
  const dates = new Set(dateDaysBack(dateStr, days));
  const rows = readJsonl(ROUTING_DECISIONS_PATH, MAX_ROUTING_ROWS);
  const out = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const mode = row.mode || (row.handoff_packet && row.handoff_packet.mode);
    if (!isHyperCreativeMode(mode)) continue;
    const d = toDateOnly(row.ts || row.date);
    if (!d || !dates.has(d)) continue;
    const text = [row.intent, row.task, row.reason, row.mode_reason, row.route_class]
      .map((x) => String(x || '').trim())
      .filter(Boolean)
      .join(' ');
    const words = tokenize(text).slice(0, 4);
    const token = normalizeToken(words.join('-'));
    if (!token) continue;
    out.push({
      token,
      score: 12 + clampInt(row.tier || 1, 1, 3) * 2,
      source: 'hyper_creative_mode',
      refs: []
    });
  }
  return out;
}

function buildIdleSeedSet(dateStr) {
  const seeds = [...collectDreamSeeds(dateStr, WINDOW_DAYS), ...collectHyperSeeds(dateStr, WINDOW_DAYS)];
  const byToken = new Map();
  for (const s of seeds) {
    const token = normalizeToken(s && s.token);
    if (!token) continue;
    if (!byToken.has(token)) {
      byToken.set(token, {
        token,
        score: 0,
        sources: new Set(),
        refs: []
      });
    }
    const ent = byToken.get(token);
    ent.score += Number(s && s.score || 0);
    ent.sources.add(String(s && s.source || 'unknown'));
    ent.refs = Array.from(new Set([...ent.refs, ...((s && s.refs) || [])])).slice(0, 4);
  }
  return Array.from(byToken.values())
    .map((e) => ({
      token: e.token,
      score: Number(e.score.toFixed(3)),
      sources: Array.from(e.sources).sort(),
      refs: e.refs
    }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return String(a.token).localeCompare(String(b.token));
    })
    .slice(0, MAX_SEEDS);
}

function buildIdlePrompt(seeds, dateStr) {
  const payload = seeds.map((s) => ({
    token: s.token,
    score: s.score,
    sources: s.sources,
    refs: s.refs.slice(0, 2)
  }));
  return [
    'You are a local memory dream synthesizer.',
    'Goal: generate compact creative links from seed themes.',
    'Return ONLY valid JSON with this exact shape:',
    '{"dream_links":[{"token":"kebab-token","hint":"short hint","confidence":1,"refs":["memory/file.md#node"]}]}',
    `Rules: max ${MAX_IDLE_LINKS} links; token must be lowercase kebab; hint <= 120 chars; confidence integer 1..5; no markdown.`,
    `Context date: ${dateStr}`,
    `Seeds JSON: ${JSON.stringify(payload)}`
  ].join('\n');
}

function normalizeIdleLinks(parsed, seeds) {
  const out = [];
  const rows = parsed && Array.isArray(parsed.dream_links) ? parsed.dream_links : [];
  for (const row of rows.slice(0, MAX_IDLE_LINKS)) {
    const tokenRaw = row && row.token ? row.token : tokenize(row && row.hint).slice(0, 4).join('-');
    const token = normalizeToken(tokenRaw);
    if (!token) continue;
    const hint = String(row && row.hint || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    const confidence = clampInt(row && row.confidence || 3, 1, 5);
    const refs = Array.isArray(row && row.refs)
      ? row.refs.map((r) => String(r || '').trim().slice(0, 180)).filter((r) => r.includes('#')).slice(0, 4)
      : [];
    out.push({ token, hint, confidence, refs });
  }
  if (out.length > 0) return dedupeLinks(out).slice(0, MAX_IDLE_LINKS);
  const fallback = seeds.slice(0, Math.min(3, MAX_IDLE_LINKS)).map((s) => ({
    token: s.token,
    hint: `idle-link for ${s.token}`,
    confidence: 2,
    refs: Array.isArray(s.refs) ? s.refs.slice(0, 2) : []
  }));
  return dedupeLinks(fallback);
}

function dedupeLinks(rows) {
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const t = normalizeToken(r && r.token);
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push({
      token: t,
      hint: String(r && r.hint || '').slice(0, 120),
      confidence: clampInt(r && r.confidence || 3, 1, 5),
      refs: Array.isArray(r && r.refs) ? r.refs.slice(0, 4) : []
    });
  }
  return out;
}

function writeIdleRow(dateStr, model, seeds, links, rawJson) {
  ensureDir(IDLE_DIR);
  const uid = stableUid(`idle_dream|${dateStr}|${nowIso()}|${model}`, { prefix: 'idr', length: 24 });
  const row = {
    ts: nowIso(),
    type: 'idle_dream',
    uid,
    date: dateStr,
    model: model || null,
    seed_count: seeds.length,
    links
  };
  appendJsonl(path.join(IDLE_DIR, `${dateStr}.jsonl`), row);
  writeJson(path.join(IDLE_DIR, `${dateStr}__${uid}.json`), {
    ts: row.ts,
    uid,
    model,
    seeds,
    links,
    llm_raw: rawJson
  });
  return row;
}

function loadIdleRows(dateStr, days, afterTs) {
  const dates = dateDaysBack(dateStr, days);
  const afterMs = afterTs ? Date.parse(String(afterTs)) : null;
  const rows = [];
  for (const d of dates) {
    const fp = path.join(IDLE_DIR, `${d}.jsonl`);
    const parsed = readJsonl(fp);
    for (const row of parsed) {
      if (!row || row.type !== 'idle_dream') continue;
      const ts = Date.parse(String(row.ts || ''));
      if (afterMs != null && Number.isFinite(ts) && ts <= afterMs) continue;
      rows.push(row);
    }
  }
  rows.sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')));
  return rows;
}

function buildRemPrompt(materialRows, dateStr) {
  const digest = [];
  for (const row of materialRows.slice(-20)) {
    const links = Array.isArray(row.links) ? row.links.slice(0, 5) : [];
    for (const l of links) {
      digest.push({
        uid: row.uid || null,
        token: l.token || null,
        hint: String(l.hint || '').slice(0, 120),
        confidence: clampInt(l.confidence || 3, 1, 5)
      });
    }
  }
  return [
    'You are a local REM consolidator.',
    'Goal: quantize diluted dream links into ranked concise syntheses.',
    'Return ONLY valid JSON with this exact shape:',
    '{"quantized":[{"token":"kebab-token","weight":1,"synthesis":"short line","source_uids":["uid"]}]}',
    `Rules: max ${MAX_REM_LINKS}; weight integer 1..100; synthesis <= 140 chars; no markdown.`,
    `Context date: ${dateStr}`,
    `Idle material JSON: ${JSON.stringify(digest)}`
  ].join('\n');
}

function fallbackQuantized(materialRows) {
  const byToken = new Map();
  for (const row of materialRows) {
    const links = Array.isArray(row && row.links) ? row.links : [];
    for (const l of links) {
      const token = normalizeToken(l && l.token);
      if (!token) continue;
      if (!byToken.has(token)) {
        byToken.set(token, { token, sum: 0, hints: [], uids: [] });
      }
      const ent = byToken.get(token);
      ent.sum += clampInt(l && l.confidence || 3, 1, 5);
      if (l && l.hint) ent.hints.push(String(l.hint).slice(0, 120));
      if (row && row.uid) ent.uids.push(String(row.uid));
    }
  }
  return Array.from(byToken.values())
    .map((e) => ({
      token: e.token,
      weight: Math.min(100, e.sum * 4),
      synthesis: e.hints[0] || `quantized ${e.token}`,
      source_uids: Array.from(new Set(e.uids)).slice(0, 8)
    }))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, MAX_REM_LINKS);
}

function normalizeQuantized(parsed, materialRows) {
  const rows = parsed && Array.isArray(parsed.quantized) ? parsed.quantized : [];
  const out = [];
  for (const row of rows.slice(0, MAX_REM_LINKS)) {
    const token = normalizeToken(row && row.token);
    if (!token) continue;
    out.push({
      token,
      weight: clampInt(row && row.weight || 20, 1, 100),
      synthesis: String(row && row.synthesis || '').replace(/\s+/g, ' ').trim().slice(0, 140),
      source_uids: Array.isArray(row && row.source_uids)
        ? Array.from(new Set(row.source_uids.map((x) => String(x || '').trim()).filter(Boolean))).slice(0, 8)
        : []
    });
  }
  if (out.length > 0) return out;
  return fallbackQuantized(materialRows);
}

function writeRemResult(dateStr, model, materialRows, quantized, rawJson) {
  ensureDir(REM_DIR);
  const uid = stableUid(`rem_dream|${dateStr}|${nowIso()}|${model}`, { prefix: 'rem', length: 24 });
  const out = {
    ts: nowIso(),
    type: 'rem_quantized',
    uid,
    date: dateStr,
    model: model || null,
    source_idle_rows: materialRows.length,
    quantized
  };
  writeJson(path.join(REM_DIR, `${dateStr}.json`), out);
  writeJson(path.join(REM_DIR, `${dateStr}__${uid}.json`), {
    ...out,
    llm_raw: rawJson
  });
  return out;
}

function shouldRunIdle(state, force) {
  if (force) return { run: true, reason: 'forced' };
  if (!state || !state.last_idle_ts) return { run: true, reason: 'first_run' };
  const lastMs = Date.parse(String(state.last_idle_ts || ''));
  if (!Number.isFinite(lastMs)) return { run: true, reason: 'bad_last_idle_ts' };
  const deltaMinutes = (Date.now() - lastMs) / 60000;
  if (deltaMinutes >= IDLE_MIN_MINUTES) return { run: true, reason: 'interval_elapsed' };
  return { run: false, reason: 'idle_interval_not_elapsed', delta_minutes: Number(deltaMinutes.toFixed(2)) };
}

function shouldRunRem(state, force) {
  if (force) return { run: true, reason: 'forced' };
  const idleRunsSinceRem = Number(state && state.idle_runs_since_rem || 0);
  if ((!state || !state.last_rem_ts) && idleRunsSinceRem >= 1) {
    return { run: true, reason: 'first_rem_bootstrap' };
  }
  if (idleRunsSinceRem < REM_MIN_IDLE_RUNS) {
    return {
      run: false,
      reason: 'insufficient_idle_runs_since_rem',
      idle_runs_since_rem: idleRunsSinceRem
    };
  }
  if (!state || !state.last_rem_ts) return { run: true, reason: 'first_rem' };
  const lastMs = Date.parse(String(state.last_rem_ts || ''));
  if (!Number.isFinite(lastMs)) return { run: true, reason: 'bad_last_rem_ts' };
  const deltaMinutes = (Date.now() - lastMs) / 60000;
  if (deltaMinutes >= REM_MIN_MINUTES) return { run: true, reason: 'rem_interval_elapsed' };
  return { run: false, reason: 'rem_interval_not_elapsed', delta_minutes: Number(deltaMinutes.toFixed(2)) };
}

function runIdlePass(dateStr, state, force) {
  const idleGate = shouldRunIdle(state, force);
  if (!idleGate.run) {
    return { ok: true, skipped: true, reason: idleGate.reason, gate: idleGate };
  }

  let seeds = buildIdleSeedSet(dateStr);
  let bootstrap = null;
  if (seeds.length === 0) {
    bootstrap = runMemoryDreamBootstrap(dateStr);
    if (bootstrap && bootstrap.ok) {
      seeds = buildIdleSeedSet(dateStr);
    }
  }
  if (seeds.length === 0) {
    return {
      ok: true,
      skipped: true,
      reason: 'no_dream_seeds_available',
      bootstrap: bootstrap ? {
        ok: !!bootstrap.ok,
        reason: bootstrap.reason || null,
        pointer_rows: bootstrap.payload ? Number(bootstrap.payload.pointer_rows || 0) : null,
        themes: bootstrap.payload ? Number(bootstrap.payload.themes || 0) : null
      } : null
    };
  }

  const availableModels = listLocalModels();
  const model = pickModel(IDLE_MODEL_ORDER, availableModels);
  if (!model) {
    return { ok: false, skipped: true, reason: 'no_local_model_available', seed_count: seeds.length, available_models: availableModels };
  }

  const lease = requestSpawnLease('idle', IDLE_REQUEST_TOKENS_EST);
  if (!lease.ok) {
    return {
      ok: true,
      skipped: true,
      reason: String(lease.reason || 'spawn_budget_denied'),
      model,
      spawn_budget: lease
    };
  }

  const prompt = buildIdlePrompt(seeds, dateStr);
  let release = null;
  try {
    const llm = runLocalModel(model, prompt, LLM_TIMEOUT_MS, 'idle');
    if (!llm.ok) {
      const links = normalizeIdleLinks(null, seeds);
      const row = writeIdleRow(dateStr, null, seeds, links, {
        strategy: 'deterministic_fallback',
        reason: 'local_model_idle_failed',
        failed_model: model,
        code: llm.code,
        signal: llm.signal || null,
        timed_out: llm.timed_out === true,
        error: llm.error || null,
        stderr: String(llm.stderr || '').slice(-240)
      });
      return {
        ok: true,
        skipped: false,
        degraded: true,
        reason: 'deterministic_idle_fallback',
        failed_model: model,
        fallback_model: null,
        code: llm.code,
        signal: llm.signal || null,
        timed_out: llm.timed_out === true,
        error: llm.error || null,
        stderr: String(llm.stderr || '').slice(-240),
        seed_count: seeds.length,
        link_count: links.length,
        row_uid: row.uid
      };
    }
    const parsed = extractJsonObject(llm.stdout);
    const links = normalizeIdleLinks(parsed, seeds);
    const row = writeIdleRow(dateStr, model, seeds, links, parsed);
    return {
      ok: true,
      skipped: false,
      model,
      seed_count: seeds.length,
      link_count: links.length,
      row_uid: row.uid,
      spawn_budget: {
        module: lease.module,
        granted_cells: lease.granted_cells
      }
    };
  } finally {
    release = releaseSpawnLease(lease, 'idle');
    if (!release.ok) {
      appendJsonl(LEDGER_PATH, {
        ts: nowIso(),
        type: 'idle_dream_spawn_release_error',
        phase: 'idle',
        module: lease.module,
        reason: release.reason || null,
        error: release.error || null
      });
    }
  }
}

function runRemPass(dateStr, state, force) {
  const remGate = shouldRunRem(state, force);
  if (!remGate.run) {
    return { ok: true, skipped: true, reason: remGate.reason, gate: remGate };
  }

  const materialRows = loadIdleRows(dateStr, WINDOW_DAYS, state && state.last_rem_ts ? state.last_rem_ts : null);
  if (materialRows.length === 0) {
    return { ok: true, skipped: true, reason: 'no_idle_material_since_last_rem', strategy: REM_STRATEGY };
  }

  const strategy = (REM_STRATEGY === 'local' || REM_STRATEGY === 'deterministic')
    ? REM_STRATEGY
    : 'deterministic';

  const requestedTokens = strategy === 'local'
    ? REM_REQUEST_TOKENS_EST_LOCAL
    : REM_REQUEST_TOKENS_EST_DETERMINISTIC;
  const lease = requestSpawnLease('rem', requestedTokens);
  if (!lease.ok) {
    return {
      ok: true,
      skipped: true,
      reason: String(lease.reason || 'spawn_budget_denied'),
      strategy,
      spawn_budget: lease
    };
  }

  let release = null;
  try {
    if (strategy === 'deterministic') {
      const quantized = fallbackQuantized(materialRows);
      const rem = writeRemResult(dateStr, null, materialRows, quantized, {
        strategy: 'deterministic',
        note: 'no_llm_used'
      });
      return {
        ok: true,
        skipped: false,
        strategy: 'deterministic',
        model: null,
        source_idle_rows: materialRows.length,
        quantized_count: quantized.length,
        rem_uid: rem.uid,
        spawn_budget: {
          module: lease.module,
          granted_cells: lease.granted_cells
        }
      };
    }

    const availableModels = listLocalModels();
    const model = pickModel(REM_MODEL_ORDER, availableModels);
    if (!model) {
      return {
        ok: false,
        skipped: true,
        reason: 'no_local_model_available_for_rem',
        strategy,
        available_models: availableModels
      };
    }
    const prompt = buildRemPrompt(materialRows, dateStr);
    const llm = runLocalModel(model, prompt, REM_TIMEOUT_MS, 'rem');
    if (!llm.ok) {
      const quantized = fallbackQuantized(materialRows);
      const rem = writeRemResult(dateStr, null, materialRows, quantized, {
        strategy: 'deterministic_fallback',
        reason: 'local_model_rem_failed',
        failed_model: model,
        code: llm.code,
        signal: llm.signal || null,
        timed_out: llm.timed_out === true,
        error: llm.error || null,
        stderr: String(llm.stderr || '').slice(-240)
      });
      return {
        ok: true,
        skipped: false,
        degraded: true,
        reason: 'deterministic_rem_fallback',
        strategy,
        failed_model: model,
        model: null,
        code: llm.code,
        signal: llm.signal || null,
        timed_out: llm.timed_out === true,
        error: llm.error || null,
        stderr: String(llm.stderr || '').slice(-240),
        source_idle_rows: materialRows.length,
        quantized_count: quantized.length,
        rem_uid: rem.uid
      };
    }
    const parsed = extractJsonObject(llm.stdout);
    const quantized = normalizeQuantized(parsed, materialRows);
    const rem = writeRemResult(dateStr, model, materialRows, quantized, parsed);
    return {
      ok: true,
      skipped: false,
      strategy,
      model,
      source_idle_rows: materialRows.length,
      quantized_count: quantized.length,
      rem_uid: rem.uid,
      spawn_budget: {
        module: lease.module,
        granted_cells: lease.granted_cells
      }
    };
  } finally {
    release = releaseSpawnLease(lease, 'rem');
    if (!release.ok) {
      appendJsonl(LEDGER_PATH, {
        ts: nowIso(),
        type: 'idle_dream_spawn_release_error',
        phase: 'rem',
        module: lease.module,
        reason: release.reason || null,
        error: release.error || null
      });
    }
  }
}

function runCycle(dateStr, opts = {}) {
  const force = opts.force === true;
  const remOnly = opts.remOnly === true;
  const state = loadState();
  const before = { ...state };
  let idleResult = { ok: true, skipped: true, reason: 'rem_only' };
  if (!remOnly) {
    idleResult = runIdlePass(dateStr, state, force);
    if (idleResult.ok && !idleResult.skipped) {
      state.last_idle_ts = nowIso();
      state.idle_runs += 1;
      state.idle_runs_since_rem = Number(state.idle_runs_since_rem || 0) + 1;
      state.last_idle_model = idleResult.model || null;
    }
  }

  const remForce = force;
  const remResult = runRemPass(dateStr, state, remForce);
  if (remResult.ok && !remResult.skipped) {
    state.last_rem_ts = nowIso();
    state.rem_runs += 1;
    state.idle_runs_since_rem = 0;
    state.last_rem_model = remResult.model || null;
  }
  saveState(state);

  const out = {
    ok: true,
    type: 'idle_dream_cycle',
    date: dateStr,
    force,
    rem_only: remOnly,
    idle: idleResult,
    rem: remResult,
    state: {
      last_idle_ts: state.last_idle_ts,
      last_rem_ts: state.last_rem_ts,
      idle_runs: state.idle_runs,
      rem_runs: state.rem_runs,
      idle_runs_since_rem: state.idle_runs_since_rem,
      last_idle_model: state.last_idle_model,
      last_rem_model: state.last_rem_model
    }
  };
  appendJsonl(LEDGER_PATH, {
    ts: nowIso(),
    type: 'idle_dream_cycle_run',
    date: dateStr,
    force,
    rem_only: remOnly,
    idle_ok: !!(idleResult && idleResult.ok),
    idle_skipped: !!(idleResult && idleResult.skipped),
    idle_reason: idleResult ? idleResult.reason || null : null,
    rem_ok: !!(remResult && remResult.ok),
    rem_skipped: !!(remResult && remResult.skipped),
    rem_reason: remResult ? remResult.reason || null : null,
    idle_runs_before: Number(before.idle_runs || 0),
    idle_runs_after: Number(state.idle_runs || 0),
    rem_runs_before: Number(before.rem_runs || 0),
    rem_runs_after: Number(state.rem_runs || 0)
  });
  return out;
}

function status() {
  const state = loadState();
  const today = toDate();
  const idleTodayPath = path.join(IDLE_DIR, `${today}.jsonl`);
  const remTodayPath = path.join(REM_DIR, `${today}.json`);
  const idleRowsToday = readJsonl(idleTodayPath);
  const remToday = readJsonSafe(remTodayPath, null);
  return {
    ok: true,
    type: 'idle_dream_cycle_status',
    state,
    today,
    idle_rows_today: idleRowsToday.length,
    rem_exists_today: !!remToday,
    rem_quantized_today: remToday && Array.isArray(remToday.quantized) ? remToday.quantized.length : 0
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim().toLowerCase();
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'run') {
    const dateStr = toDate(args._[1]);
    const force = String(args.force || '') === '1' || args.force === true;
    const remOnly = String(args['rem-only'] || '') === '1' || args['rem-only'] === true;
    process.stdout.write(JSON.stringify(runCycle(dateStr, { force, remOnly })) + '\n');
    return;
  }
  if (cmd === 'status') {
    process.stdout.write(JSON.stringify(status()) + '\n');
    return;
  }
  usage();
  process.exit(2);
}

if (require.main === module) {
  main();
}

module.exports = {
  runCycle,
  status,
  buildIdleSeedSet,
  collectDreamSeeds,
  collectHyperSeeds,
  normalizeIdleLinks,
  normalizeQuantized
};
