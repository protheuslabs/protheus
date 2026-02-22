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
const { emitPainSignal } = require('../autonomy/pain_signal.js');
const { enforceMutationProvenance, recordMutationAudit } = require('../../lib/mutation_provenance.js');
const {
  DEFAULT_STATE_DIR: GLOBAL_BUDGET_STATE_DIR,
  DEFAULT_EVENTS_PATH: GLOBAL_BUDGET_EVENTS_PATH,
  DEFAULT_AUTOPAUSE_PATH: GLOBAL_BUDGET_AUTOPAUSE_PATH,
  writeSystemBudgetDecision,
  loadSystemBudgetAutopauseState,
  setSystemBudgetAutopause,
  evaluateSystemBudgetGuard
} = require('../budget/system_budget.js');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT_SOURCE = 'systems/memory/idle_dream_cycle.js';
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
const FAILURE_POINTERS_DIR = process.env.IDLE_DREAM_FAILURE_POINTERS_DIR
  ? path.resolve(String(process.env.IDLE_DREAM_FAILURE_POINTERS_DIR))
  : path.join(REPO_ROOT, 'state', 'memory', 'failure_pointers');
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
const DREAM_BUDGET_MODULE = normalizeToken(process.env.IDLE_DREAM_BUDGET_MODULE || 'dream_cycle') || 'dream_cycle';
const DREAM_BUDGET_STATE_DIR = process.env.IDLE_DREAM_BUDGET_STATE_DIR
  ? path.resolve(String(process.env.IDLE_DREAM_BUDGET_STATE_DIR))
  : GLOBAL_BUDGET_STATE_DIR;
const DREAM_BUDGET_EVENTS_PATH = process.env.IDLE_DREAM_BUDGET_EVENTS_PATH
  ? path.resolve(String(process.env.IDLE_DREAM_BUDGET_EVENTS_PATH))
  : GLOBAL_BUDGET_EVENTS_PATH;
const DREAM_BUDGET_AUTOPAUSE_PATH = process.env.IDLE_DREAM_BUDGET_AUTOPAUSE_PATH
  ? path.resolve(String(process.env.IDLE_DREAM_BUDGET_AUTOPAUSE_PATH))
  : GLOBAL_BUDGET_AUTOPAUSE_PATH;

const IDLE_MIN_MINUTES = clampInt(process.env.IDLE_DREAM_MIN_IDLE_MINUTES || 45, 5, 24 * 60);
const REM_MIN_MINUTES = clampInt(process.env.IDLE_DREAM_REM_MIN_MINUTES || 180, 30, 7 * 24 * 60);
const REM_MIN_IDLE_RUNS = clampInt(process.env.IDLE_DREAM_REM_MIN_IDLE_RUNS || 2, 1, 50);
const WINDOW_DAYS = clampInt(process.env.IDLE_DREAM_WINDOW_DAYS || 3, 1, 14);
const MAX_SEEDS = clampInt(process.env.IDLE_DREAM_MAX_SEEDS || 10, 2, 30);
const FAILURE_SEED_SHARE = clampFloat(process.env.IDLE_DREAM_FAILURE_SEED_SHARE, 0, 0.9, 0.35);
const FAILURE_SEED_MIN = clampInt(process.env.IDLE_DREAM_FAILURE_SEED_MIN || 1, 0, MAX_SEEDS);
const MAX_IDLE_LINKS = clampInt(process.env.IDLE_DREAM_MAX_LINKS || 6, 1, 20);
const MAX_REM_LINKS = clampInt(process.env.IDLE_DREAM_REM_MAX_LINKS || 8, 1, 24);
const LLM_TIMEOUT_MS = clampInt(process.env.IDLE_DREAM_TIMEOUT_MS || 25000, 5000, 10 * 60 * 1000);
const REM_TIMEOUT_MS = clampInt(process.env.IDLE_DREAM_REM_TIMEOUT_MS || 30000, 5000, 10 * 60 * 1000);
const IDLE_PASS_MAX_MS = clampInt(process.env.IDLE_DREAM_IDLE_PASS_MAX_MS || 120000, 10000, 15 * 60 * 1000);
const REM_PASS_MAX_MS = clampInt(process.env.IDLE_DREAM_REM_PASS_MAX_MS || 150000, 10000, 15 * 60 * 1000);
const MAX_ROUTING_ROWS = clampInt(process.env.IDLE_DREAM_MAX_ROUTING_ROWS || 5000, 100, 50000);
const IDLE_REQUEST_TOKENS_EST = clampInt(process.env.IDLE_DREAM_IDLE_TOKENS_EST || 220, 50, 20000);
const REM_REQUEST_TOKENS_EST_LOCAL = clampInt(process.env.IDLE_DREAM_REM_TOKENS_EST_LOCAL || 320, 50, 20000);
const REM_REQUEST_TOKENS_EST_DETERMINISTIC = clampInt(process.env.IDLE_DREAM_REM_TOKENS_EST_DETERMINISTIC || 80, 0, 20000);
const MEMORY_DREAM_BOOTSTRAP_TIMEOUT_MS = clampInt(process.env.IDLE_DREAM_BOOTSTRAP_TIMEOUT_MS || 25000, 5000, 120000);
const MODEL_COOLDOWN_BASE_MS = clampInt(process.env.IDLE_DREAM_MODEL_COOLDOWN_MS || 45 * 60 * 1000, 60 * 1000, 6 * 60 * 60 * 1000);
const MODEL_COOLDOWN_MAX_MS = clampInt(process.env.IDLE_DREAM_MODEL_COOLDOWN_MAX_MS || 6 * 60 * 60 * 1000, MODEL_COOLDOWN_BASE_MS, 24 * 60 * 60 * 1000);
const MODEL_TIMEOUT_COOLDOWN_BASE_MS = clampInt(
  process.env.IDLE_DREAM_TIMEOUT_COOLDOWN_MS || 3 * 60 * 1000,
  60 * 1000,
  MODEL_COOLDOWN_BASE_MS
);
const MODEL_PROVIDER_COOLDOWN_BASE_MS = clampInt(
  process.env.IDLE_DREAM_PROVIDER_COOLDOWN_MS || 2 * 60 * 1000,
  60 * 1000,
  MODEL_TIMEOUT_COOLDOWN_BASE_MS
);
const MODEL_HEALTH_MAX = clampInt(process.env.IDLE_DREAM_MODEL_HEALTH_MAX || 32, 4, 128);
const MODEL_MAX_ATTEMPTS = clampInt(process.env.IDLE_DREAM_MODEL_MAX_ATTEMPTS || 2, 1, 3);
const MODEL_MAX_MODELS_PER_PASS = clampInt(process.env.IDLE_DREAM_MAX_MODELS_PER_PASS || 4, 1, 12);
const MODEL_RETRY_TIMEOUT_PCT = clampInt(process.env.IDLE_DREAM_MODEL_RETRY_TIMEOUT_PCT || 175, 100, 500);
const CLOUD_MODEL_TIMEOUT_PCT = clampInt(process.env.IDLE_DREAM_CLOUD_TIMEOUT_PCT || 170, 100, 600);
const MODEL_PREFLIGHT_ENABLED = String(process.env.IDLE_DREAM_MODEL_PREFLIGHT_ENABLED || '1').trim() !== '0';
const MODEL_PREFLIGHT_TIMEOUT_MS = clampInt(process.env.IDLE_DREAM_MODEL_PREFLIGHT_TIMEOUT_MS || 6000, 1000, 60000);
const MODEL_PREFLIGHT_CACHE_TTL_MS = clampInt(process.env.IDLE_DREAM_MODEL_PREFLIGHT_CACHE_TTL_MS || 15 * 60 * 1000, 60 * 1000, 6 * 60 * 60 * 1000);
const MODEL_PREFLIGHT_PROMPT = 'Return exactly: OK';
const MODEL_PROBATION_ENABLED = String(process.env.IDLE_DREAM_MODEL_PROBATION_ENABLED || '1').trim() !== '0';
const MODEL_PROBATION_FAILURE_STREAK = clampInt(process.env.IDLE_DREAM_MODEL_PROBATION_FAILURE_STREAK || 2, 2, 12);
const MODEL_PROBATION_TTL_MS = clampInt(process.env.IDLE_DREAM_MODEL_PROBATION_TTL_MS || 45 * 60 * 1000, 60 * 1000, 12 * 60 * 60 * 1000);

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

function clampFloat(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
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

function normalizeText(v, fallback = '') {
  const s = String(v == null ? '' : v).trim();
  return s || fallback;
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

function modelProviderKey(model) {
  const m = normalizeModelName(model);
  if (!m) return 'unknown';
  if (m.includes(':cloud') || m.endsWith('-cloud') || m.includes('/cloud')) return 'cloud';
  const slash = m.indexOf('/');
  if (slash > 0) return m.slice(0, slash);
  return 'ollama_local';
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
      last_rem_model: null,
      model_health: {}
    };
  }
  const modelHealth = base.model_health && typeof base.model_health === 'object'
    ? Object.fromEntries(
        Object.entries(base.model_health)
          .map(([k, v]) => [normalizeModelName(k), v && typeof v === 'object' ? v : {}])
          .filter(([k]) => !!k)
      )
    : {};
  return {
    version: '1.0',
    updated_ts: base.updated_ts || null,
    last_idle_ts: base.last_idle_ts || null,
    last_rem_ts: base.last_rem_ts || null,
    idle_runs: Number(base.idle_runs || 0),
    rem_runs: Number(base.rem_runs || 0),
    idle_runs_since_rem: Number(base.idle_runs_since_rem || 0),
    last_idle_model: base.last_idle_model || null,
    last_rem_model: base.last_rem_model || null,
    model_health: modelHealth
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

function fallbackDreamModels(state) {
  const seeded = [];
  for (const m of [...IDLE_MODEL_ORDER, ...REM_MODEL_ORDER]) {
    const clean = normalizeModelName(m);
    if (clean) seeded.push(clean);
  }
  const health = state && state.model_health && typeof state.model_health === 'object'
    ? state.model_health
    : {};
  const learned = Object.entries(health)
    .map(([model, row]) => {
      const entry = row && typeof row === 'object' ? row : {};
      const successStreak = Number(entry.success_streak || 0);
      const lastSuccessTs = String(entry.last_success_ts || '');
      const lastEventTs = String(entry.last_event_ts || '');
      const okSignal = successStreak > 0 || !!lastSuccessTs;
      const ts = Date.parse(lastSuccessTs || lastEventTs || '');
      return {
        model: normalizeModelName(model),
        okSignal,
        ts: Number.isFinite(ts) ? ts : 0
      };
    })
    .filter((it) => !!it.model && it.okSignal)
    .sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0))
    .map((it) => it.model);
  return Array.from(new Set([...seeded, ...learned])).filter(Boolean);
}

function listLocalModels(state = null) {
  const fake = String(process.env.IDLE_DREAM_FAKE_MODELS || '').trim();
  if (fake) return parseCsvOrder(fake).map(normalizeModelName).filter(Boolean);
  const listed = listLocalOllamaModels({
    timeoutMs: 5000,
    cwd: REPO_ROOT,
    source: 'idle_dream_cycle'
  });
  const listedModels = Array.from(new Set((listed.models || []).map(normalizeModelName).filter(Boolean)));
  if (listed.ok && listedModels.length > 0) return listedModels;
  const fallback = fallbackDreamModels(state);
  if (fallback.length > 0) {
    appendJsonl(LEDGER_PATH, {
      ts: nowIso(),
      type: 'idle_dream_model_list_fallback',
      source: listed && listed.ok ? 'empty_model_list' : 'list_failed',
      code: listed && listed.code != null ? Number(listed.code) : null,
      fallback_count: fallback.length,
      fallback_models: fallback.slice(0, 8)
    });
  }
  return fallback;
}

function modelHealthEntry(state, model) {
  const health = state && state.model_health && typeof state.model_health === 'object'
    ? state.model_health
    : {};
  const key = normalizeModelName(model);
  const entry = key ? health[key] : null;
  return entry && typeof entry === 'object' ? entry : null;
}

function pruneModelHealth(state) {
  if (!state || !state.model_health || typeof state.model_health !== 'object') return;
  const rows = Object.entries(state.model_health).map(([model, raw]) => {
    const row = raw && typeof raw === 'object' ? raw : {};
    const ts = Date.parse(String(row.last_event_ts || row.last_success_ts || row.last_failure_ts || ''));
    return { model: normalizeModelName(model), row, ts: Number.isFinite(ts) ? ts : 0 };
  }).filter((it) => !!it.model);
  if (rows.length <= MODEL_HEALTH_MAX) return;
  rows.sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0) || String(a.model).localeCompare(String(b.model)));
  const keep = rows.slice(0, MODEL_HEALTH_MAX);
  state.model_health = Object.fromEntries(keep.map((it) => [it.model, it.row]));
}

function modelPreflightCache(state, model) {
  const entry = modelHealthEntry(state, model);
  const until = String(entry && entry.preflight_ok_until_ts || '');
  const untilMs = Date.parse(until);
  if (!Number.isFinite(untilMs) || untilMs <= Date.now()) {
    return { hit: false, until_ts: null };
  }
  return {
    hit: true,
    until_ts: until,
    ttl_ms: Number(entry && entry.preflight_ttl_ms || 0),
    phase: entry && entry.preflight_ok_phase ? String(entry.preflight_ok_phase) : null
  };
}

function modelOnPreflightSuccess(state, model, phase) {
  if (!state || !model) return null;
  if (!state.model_health || typeof state.model_health !== 'object') state.model_health = {};
  const key = normalizeModelName(model);
  const prev = modelHealthEntry(state, key) || {};
  const phaseKey = String(phase || '').trim().toLowerCase() || null;
  const now = nowIso();
  const untilTs = new Date(Date.now() + MODEL_PREFLIGHT_CACHE_TTL_MS).toISOString();
  const next = {
    ...prev,
    model: key,
    last_event_ts: now,
    preflight_ok_ts: now,
    preflight_ok_until_ts: untilTs,
    preflight_ok_phase: phaseKey,
    preflight_ttl_ms: MODEL_PREFLIGHT_CACHE_TTL_MS
  };
  state.model_health[key] = next;
  pruneModelHealth(state);
  appendJsonl(LEDGER_PATH, {
    ts: now,
    type: 'idle_dream_model_preflight_cache_set',
    phase: phaseKey,
    model: key,
    ttl_ms: MODEL_PREFLIGHT_CACHE_TTL_MS,
    until_ts: untilTs
  });
  return next;
}

function modelOnFailure(state, model, phase, llm) {
  if (!state || !model) return null;
  if (!state.model_health || typeof state.model_health !== 'object') state.model_health = {};
  const key = normalizeModelName(model);
  const prev = modelHealthEntry(state, key) || {};
  const cachedUntil = String(prev.preflight_ok_until_ts || '');
  const cachedUntilMs = Date.parse(cachedUntil);
  const hadPreflightCache = Number.isFinite(cachedUntilMs) && cachedUntilMs > Date.now();
  const providerUnavailable = isProviderUnavailableFailure(llm);
  const failureStreak = providerUnavailable
    ? 1
    : clampInt(Number(prev.failure_streak || 0) + 1, 1, 12);
  const baseCooldownMs = providerUnavailable
    ? MODEL_PROVIDER_COOLDOWN_BASE_MS
    : (llm && llm.timed_out === true
      ? MODEL_TIMEOUT_COOLDOWN_BASE_MS
      : MODEL_COOLDOWN_BASE_MS);
  const cooldownMs = Math.min(MODEL_COOLDOWN_MAX_MS, baseCooldownMs * failureStreak);
  const cooldownUntil = new Date(Date.now() + cooldownMs).toISOString();
  const reason = providerUnavailable
    ? 'provider_unavailable'
    : (llm && llm.timed_out === true
      ? 'timeout'
      : llm && llm.error
        ? 'runtime_error'
        : `exit_${Number(llm && llm.code != null ? llm.code : 1)}`);
  const probationEnabled = MODEL_PROBATION_ENABLED === true;
  const probationTriggered = probationEnabled && failureStreak >= MODEL_PROBATION_FAILURE_STREAK;
  const probationUntil = probationTriggered
    ? new Date(Date.now() + MODEL_PROBATION_TTL_MS).toISOString()
    : null;
  const next = {
    ...prev,
    model: key,
    last_phase: String(phase || '').trim().toLowerCase() || null,
    last_failure_ts: nowIso(),
    last_event_ts: nowIso(),
    last_failure_reason: reason,
    last_failure_code: Number(llm && llm.code != null ? llm.code : 1),
    timed_out: llm && llm.timed_out === true,
    failure_streak: failureStreak,
    success_streak: 0,
    cooldown_ms: cooldownMs,
    cooldown_until_ts: cooldownUntil,
    probation_until_ts: probationUntil,
    probation_reason: probationTriggered ? reason : null,
    preflight_ok_ts: null,
    preflight_ok_until_ts: null,
    preflight_ok_phase: null,
    preflight_ttl_ms: 0
  };
  state.model_health[key] = next;
  pruneModelHealth(state);
  if (hadPreflightCache) {
    appendJsonl(LEDGER_PATH, {
      ts: nowIso(),
      type: 'idle_dream_model_preflight_cache_cleared',
      phase: next.last_phase,
      model: key,
      reason
    });
  }
  if (probationTriggered !== true && prev && prev.probation_until_ts) {
    appendJsonl(LEDGER_PATH, {
      ts: nowIso(),
      type: 'idle_dream_model_probation_cleared',
      phase: next.last_phase,
      model: key,
      reason: 'below_failure_threshold'
    });
  }
  if (probationTriggered) {
    appendJsonl(LEDGER_PATH, {
      ts: nowIso(),
      type: 'idle_dream_model_probation_set',
      phase: next.last_phase,
      model: key,
      reason,
      failure_streak: failureStreak,
      probation_until_ts: probationUntil,
      probation_ttl_ms: MODEL_PROBATION_TTL_MS
    });
  }
  appendJsonl(LEDGER_PATH, {
    ts: nowIso(),
    type: 'idle_dream_model_cooldown_set',
    phase: next.last_phase,
    model: key,
    reason,
    failure_streak: failureStreak,
    cooldown_ms: cooldownMs,
    cooldown_until_ts: cooldownUntil
  });
  return next;
}

function modelOnSuccess(state, model, phase) {
  if (!state || !model) return null;
  if (!state.model_health || typeof state.model_health !== 'object') state.model_health = {};
  const key = normalizeModelName(model);
  const prev = modelHealthEntry(state, key) || {};
  const hadCooldown = !!prev.cooldown_until_ts;
  const hadProbation = !!prev.probation_until_ts;
  const next = {
    ...prev,
    model: key,
    last_phase: String(phase || '').trim().toLowerCase() || null,
    last_success_ts: nowIso(),
    last_event_ts: nowIso(),
    failure_streak: 0,
    success_streak: clampInt(Number(prev.success_streak || 0) + 1, 1, 999),
    cooldown_ms: 0,
    cooldown_until_ts: null,
    probation_until_ts: null,
    probation_reason: null,
    timed_out: false
  };
  state.model_health[key] = next;
  pruneModelHealth(state);
  if (hadCooldown) {
    appendJsonl(LEDGER_PATH, {
      ts: nowIso(),
      type: 'idle_dream_model_cooldown_cleared',
      phase: next.last_phase,
      model: key
    });
  }
  if (hadProbation) {
    appendJsonl(LEDGER_PATH, {
      ts: nowIso(),
      type: 'idle_dream_model_probation_cleared',
      phase: next.last_phase,
      model: key,
      reason: 'success'
    });
  }
  return next;
}

function pickModel(order, available, state) {
  const normAvail = new Set((available || []).map(normalizeModelName));
  const skipped = [];
  const nowMs = Date.now();
  for (const m of order || []) {
    const clean = normalizeModelName(m);
    if (!normAvail.has(clean)) continue;
    const entry = modelHealthEntry(state, clean);
    const probationUntilMs = Date.parse(String(entry && entry.probation_until_ts || ''));
    if (Number.isFinite(probationUntilMs) && probationUntilMs > nowMs) {
      skipped.push({
        model: clean,
        probation_until_ts: entry.probation_until_ts,
        probation_reason: entry.probation_reason || null,
        failure_streak: Number(entry.failure_streak || 0),
        last_failure_reason: entry.last_failure_reason || null,
        skipped_by: 'probation'
      });
      continue;
    }
    const untilMs = Date.parse(String(entry && entry.cooldown_until_ts || ''));
    if (Number.isFinite(untilMs) && untilMs > nowMs) {
      skipped.push({
        model: clean,
        cooldown_until_ts: entry.cooldown_until_ts,
        failure_streak: Number(entry.failure_streak || 0),
        last_failure_reason: entry.last_failure_reason || null
      });
      continue;
    }
    return { model: clean, skipped_models: skipped };
  }
  const list = Array.from(normAvail).sort();
  for (const clean of list) {
    const entry = modelHealthEntry(state, clean);
    const probationUntilMs = Date.parse(String(entry && entry.probation_until_ts || ''));
    if (Number.isFinite(probationUntilMs) && probationUntilMs > nowMs) {
      skipped.push({
        model: clean,
        probation_until_ts: entry.probation_until_ts,
        probation_reason: entry.probation_reason || null,
        failure_streak: Number(entry.failure_streak || 0),
        last_failure_reason: entry.last_failure_reason || null,
        skipped_by: 'probation'
      });
      continue;
    }
    const untilMs = Date.parse(String(entry && entry.cooldown_until_ts || ''));
    if (Number.isFinite(untilMs) && untilMs > nowMs) {
      skipped.push({
        model: clean,
        cooldown_until_ts: entry.cooldown_until_ts,
        failure_streak: Number(entry.failure_streak || 0),
        last_failure_reason: entry.last_failure_reason || null
      });
      continue;
    }
    return { model: clean, skipped_models: skipped };
  }
  return { model: null, skipped_models: skipped };
}

function pickModelWithProviderExclusions(order, available, state, blockedProviders) {
  const blocked = blockedProviders instanceof Set ? blockedProviders : new Set();
  const basePool = Array.isArray(available) ? available : [];
  let pool = basePool;
  if (blocked.size > 0) {
    const filtered = basePool.filter((m) => !blocked.has(modelProviderKey(m)));
    if (filtered.length > 0) pool = filtered;
  }
  return pickModel(order, pool, state);
}

function isCloudDreamModel(model) {
  const m = normalizeModelName(model);
  if (!m) return false;
  return m.includes(':cloud') || m.endsWith('-cloud') || m.includes('/cloud');
}

function timeoutForModelAttempt(baseTimeoutMs, model, attemptNumber) {
  let timeoutMs = clampInt(baseTimeoutMs || 25000, 5000, 10 * 60 * 1000);
  if (isCloudDreamModel(model)) {
    timeoutMs = Math.round(timeoutMs * (CLOUD_MODEL_TIMEOUT_PCT / 100));
  }
  if (Number(attemptNumber || 1) > 1) {
    timeoutMs = Math.round(timeoutMs * (MODEL_RETRY_TIMEOUT_PCT / 100));
  }
  return clampInt(timeoutMs, 5000, 10 * 60 * 1000);
}

function shouldRetryModelFailure(llm) {
  if (!llm || llm.ok === true) return false;
  if (isProviderUnavailableFailure(llm)) return false;
  if (llm.timed_out === true) return true;
  const blob = `${String(llm.error || '')} ${String(llm.stderr || '')}`.toLowerCase();
  return /\b(etimedout|timeout|timed out|temporar|try again|service unavailable|gateway timeout|connection reset|econnreset|econnrefused|http_5\d\d)\b/.test(blob);
}

function isProviderUnavailableFailure(llm) {
  const blob = `${String(llm && llm.error || '')} ${String(llm && llm.stderr || '')}`.toLowerCase();
  return /\b(operation not permitted|connection refused|dial tcp|connect:|127\.0\.0\.1:11434|failed to connect|no such host|econnrefused|ehostunreach|enotfound|network is unreachable)\b/.test(blob);
}

function runModelWithRetries(model, prompt, baseTimeoutMs, phase) {
  const attempts = [];
  let last = null;
  for (let attempt = 1; attempt <= MODEL_MAX_ATTEMPTS; attempt++) {
    const timeoutMs = timeoutForModelAttempt(baseTimeoutMs, model, attempt);
    const llm = runLocalModel(model, prompt, timeoutMs, phase);
    last = llm;
    attempts.push({
      attempt,
      timeout_ms: timeoutMs,
      ok: llm.ok === true,
      code: Number(llm.code != null ? llm.code : 1),
      signal: llm.signal || null,
      timed_out: llm.timed_out === true,
      error: llm.error || null,
      stderr_tail: String(llm.stderr || '').slice(-180)
    });
    if (llm.ok) {
      return { ok: true, llm, attempts };
    }
    if (attempt >= MODEL_MAX_ATTEMPTS || !shouldRetryModelFailure(llm)) break;
  }
  return { ok: false, llm: last || { ok: false, code: 1, timed_out: false, signal: null, error: 'llm_failed', stderr: '' }, attempts };
}

function runModelPreflight(state, model, phase) {
  if (!MODEL_PREFLIGHT_ENABLED) {
    return {
      ok: true,
      skipped: true,
      reason: 'disabled',
      cache_hit: false,
      cache_until_ts: null,
      timeout_ms: MODEL_PREFLIGHT_TIMEOUT_MS,
      llm: null
    };
  }
  const phaseKey = String(phase || '').trim().toLowerCase() || null;
  const cache = modelPreflightCache(state, model);
  if (cache.hit) {
    appendJsonl(LEDGER_PATH, {
      ts: nowIso(),
      type: 'idle_dream_model_preflight',
      phase: phaseKey,
      model: normalizeModelName(model),
      result: 'cache_hit',
      cache_until_ts: cache.until_ts || null
    });
    return {
      ok: true,
      skipped: true,
      reason: 'cache_hit',
      cache_hit: true,
      cache_until_ts: cache.until_ts || null,
      timeout_ms: 0,
      llm: null
    };
  }
  const llm = runLocalModel(model, MODEL_PREFLIGHT_PROMPT, MODEL_PREFLIGHT_TIMEOUT_MS, `${normalizeToken(phase || 'idle') || 'idle'}_preflight`);
  const stdout = String(stripAnsi(llm && llm.stdout || '')).trim().toUpperCase();
  const ok = llm && llm.ok === true && /\bOK\b/.test(stdout);
  if (ok) {
    const cached = modelOnPreflightSuccess(state, model, phase);
    appendJsonl(LEDGER_PATH, {
      ts: nowIso(),
      type: 'idle_dream_model_preflight',
      phase: phaseKey,
      model: normalizeModelName(model),
      result: 'ok',
      timeout_ms: MODEL_PREFLIGHT_TIMEOUT_MS
    });
    return {
      ok: true,
      skipped: false,
      reason: 'ok',
      cache_hit: false,
      cache_until_ts: cached && cached.preflight_ok_until_ts ? String(cached.preflight_ok_until_ts) : null,
      timeout_ms: MODEL_PREFLIGHT_TIMEOUT_MS,
      llm
    };
  }
  const reason = isProviderUnavailableFailure(llm)
    ? 'provider_unavailable'
    : llm && llm.timed_out === true
      ? 'timeout'
      : 'preflight_failed';
  appendJsonl(LEDGER_PATH, {
    ts: nowIso(),
    type: 'idle_dream_model_preflight',
    phase: phaseKey,
    model: normalizeModelName(model),
    result: 'failed',
    reason,
    timeout_ms: MODEL_PREFLIGHT_TIMEOUT_MS,
    code: Number(llm && llm.code != null ? llm.code : 1),
    timed_out: llm && llm.timed_out === true
  });
  return {
    ok: false,
    skipped: false,
    reason,
    cache_hit: false,
    cache_until_ts: null,
    timeout_ms: MODEL_PREFLIGHT_TIMEOUT_MS,
    llm
  };
}

function runLocalModel(model, prompt, timeoutMs, phase) {
  const fakeIdle = String(process.env.IDLE_DREAM_FAKE_IDLE_JSON || '').trim();
  const fakeRem = String(process.env.IDLE_DREAM_FAKE_REM_JSON || '').trim();
  const fakeFailures = parseCsvOrder(process.env.IDLE_DREAM_FAKE_MODEL_FAILURES || '')
    .map((row) => {
      const raw = String(row || '').trim();
      const splitAt = raw.lastIndexOf(':');
      if (splitAt <= 0) {
        return { model: normalizeModelName(raw), reason: 'error' };
      }
      return {
        model: normalizeModelName(raw.slice(0, splitAt)),
        reason: String(raw.slice(splitAt + 1) || 'error').trim().toLowerCase()
      };
    })
    .filter((row) => !!row.model);
  const forced = fakeFailures.find((row) => row.model === normalizeModelName(model));
  if (forced && forced.reason === 'timeout') {
    return { ok: false, stdout: '', stderr: 'forced_timeout', code: 124, timed_out: true, signal: 'SIGTERM', error: 'forced_timeout' };
  }
  if (forced) {
    return { ok: false, stdout: '', stderr: `forced_${forced.reason}`, code: 1, timed_out: false, signal: null, error: `forced_${forced.reason}` };
  }
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

function assessDreamBudget(dateStr, phase, requestedTokens) {
  const capability = `dream_${normalizeToken(phase || 'idle') || 'idle'}`;
  const requestTokens = Math.max(0, Math.round(Number(requestedTokens || 0)));
  const autopause = loadSystemBudgetAutopauseState({
    autopause_path: DREAM_BUDGET_AUTOPAUSE_PATH
  });
  if (autopause.active === true) {
    writeSystemBudgetDecision({
      date: dateStr,
      module: DREAM_BUDGET_MODULE,
      capability,
      request_tokens_est: requestTokens,
      decision: 'deny',
      reason: 'budget_autopause_active'
    }, {
      state_dir: DREAM_BUDGET_STATE_DIR,
      events_path: DREAM_BUDGET_EVENTS_PATH
    });
    return {
      allow: false,
      reason: 'budget_autopause_active',
      guard: null,
      autopause: {
        active: true,
        source: autopause.source || null,
        reason: autopause.reason || null,
        until: autopause.until || null
      }
    };
  }
  const guard = evaluateSystemBudgetGuard({
    date: dateStr,
    request_tokens_est: requestTokens
  }, {
    state_dir: DREAM_BUDGET_STATE_DIR,
    events_path: DREAM_BUDGET_EVENTS_PATH,
    autopause_path: DREAM_BUDGET_AUTOPAUSE_PATH
  });
  if (guard.hard_stop === true) {
    const hardReason = String((guard.hard_stop_reasons && guard.hard_stop_reasons[0]) || 'budget_guard_hard_stop');
    writeSystemBudgetDecision({
      date: dateStr,
      module: DREAM_BUDGET_MODULE,
      capability,
      request_tokens_est: requestTokens,
      decision: 'deny',
      reason: hardReason
    }, {
      state_dir: DREAM_BUDGET_STATE_DIR,
      events_path: DREAM_BUDGET_EVENTS_PATH
    });
    setSystemBudgetAutopause({
      source: 'idle_dream_cycle',
      reason: hardReason,
      pressure: 'hard',
      date: dateStr,
      minutes: 60
    }, {
      autopause_path: DREAM_BUDGET_AUTOPAUSE_PATH
    });
    return {
      allow: false,
      reason: hardReason,
      guard,
      autopause: {
        active: false,
        source: autopause.source || null,
        reason: autopause.reason || null,
        until: autopause.until || null
      }
    };
  }
  return {
    allow: true,
    reason: null,
    guard,
    autopause: {
      active: false,
      source: autopause.source || null,
      reason: autopause.reason || null,
      until: autopause.until || null
    }
  };
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

function collectFailureSeeds(dateStr, days) {
  const dates = dateDaysBack(dateStr, days);
  const rows = [];
  for (const d of dates) {
    const fp = path.join(FAILURE_POINTERS_DIR, `${d}.jsonl`);
    rows.push(...readJsonl(fp, MAX_SEEDS * 50));
  }
  const byToken = new Map();
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const tier = clampInt(row.failure_tier == null ? 3 : row.failure_tier, 1, 3);
    const topics = Array.isArray(row.topics) ? row.topics : [];
    const topicTokens = topics.map((t) => normalizeToken(t)).filter(Boolean).slice(0, 8);
    const fallbackTokens = tokenize(`${row.code || ''} ${row.title || ''}`).map((t) => normalizeToken(t)).filter(Boolean).slice(0, 6);
    const tokens = Array.from(new Set([...topicTokens, ...fallbackTokens])).slice(0, 8);
    const refs = [];
    const file = String(row.memory_file || '').trim();
    const node = String(row.node_id || '').trim();
    if (file && node) refs.push(`${file.slice(0, 140)}#${node.slice(0, 80)}`);
    const failureWindow = clampInt(Number(row.failure_count_window || 1), 1, 500);
    const perTokenScore = Math.max(2, (4 - tier) * 6) + Math.min(24, failureWindow * 2);
    for (const token of tokens) {
      if (!byToken.has(token)) {
        byToken.set(token, {
          token,
          score: 0,
          tier_min: tier,
          refs: [],
          sources: new Set()
        });
      }
      const ent = byToken.get(token);
      ent.score += perTokenScore;
      ent.tier_min = Math.min(Number(ent.tier_min || tier), tier);
      ent.refs = Array.from(new Set([...ent.refs, ...refs])).slice(0, 4);
      ent.sources.add('failure_memory');
    }
  }
  return Array.from(byToken.values())
    .map((e) => ({
      token: e.token,
      score: Number(e.score.toFixed(3)),
      source: 'failure_memory',
      sources: Array.from(e.sources),
      refs: e.refs,
      failure_tier_min: e.tier_min
    }))
    .sort((a, b) => {
      if (a.failure_tier_min !== b.failure_tier_min) return a.failure_tier_min - b.failure_tier_min;
      if (b.score !== a.score) return b.score - a.score;
      return String(a.token).localeCompare(String(b.token));
    })
    .slice(0, MAX_SEEDS);
}

function buildIdleSeedSet(dateStr) {
  const seeds = [
    ...collectDreamSeeds(dateStr, WINDOW_DAYS),
    ...collectHyperSeeds(dateStr, WINDOW_DAYS),
    ...collectFailureSeeds(dateStr, WINDOW_DAYS)
  ];
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
    const seedSources = Array.isArray(s && s.sources)
      ? s.sources
      : [s && s.source];
    for (const src of seedSources) {
      const srcName = String(src || '').trim() || 'unknown';
      ent.sources.add(srcName);
    }
    ent.refs = Array.from(new Set([...ent.refs, ...((s && s.refs) || [])])).slice(0, 4);
    if (Number.isFinite(Number(s && s.failure_tier_min))) {
      const tierVal = clampInt(Number(s.failure_tier_min || 3), 1, 3);
      ent.failure_tier_min = Number.isFinite(Number(ent.failure_tier_min))
        ? Math.min(Number(ent.failure_tier_min), tierVal)
        : tierVal;
    }
  }
  const ranked = Array.from(byToken.values())
    .map((e) => ({
      token: e.token,
      score: Number(e.score.toFixed(3)),
      sources: Array.from(e.sources).sort(),
      refs: e.refs,
      failure_tier_min: Number.isFinite(Number(e.failure_tier_min)) ? Number(e.failure_tier_min) : null
    }))
    .sort((a, b) => {
      const aTier = Number.isFinite(Number(a.failure_tier_min)) ? Number(a.failure_tier_min) : 9;
      const bTier = Number.isFinite(Number(b.failure_tier_min)) ? Number(b.failure_tier_min) : 9;
      if (aTier !== bTier) return aTier - bTier;
      if (b.score !== a.score) return b.score - a.score;
      return String(a.token).localeCompare(String(b.token));
    });
  const failureSeeds = ranked.filter((s) => Array.isArray(s.sources) && s.sources.includes('failure_memory'));
  if (failureSeeds.length <= 0) return ranked.slice(0, MAX_SEEDS);
  const quota = clampInt(
    Math.round(MAX_SEEDS * FAILURE_SEED_SHARE),
    Math.min(FAILURE_SEED_MIN, MAX_SEEDS),
    MAX_SEEDS
  );
  const selected = [];
  const used = new Set();
  for (const s of failureSeeds.slice(0, quota)) {
    selected.push(s);
    used.add(s.token);
  }
  for (const s of ranked) {
    if (selected.length >= MAX_SEEDS) break;
    if (used.has(s.token)) continue;
    selected.push(s);
    used.add(s.token);
  }
  return selected.slice(0, MAX_SEEDS);
}

function buildIdlePrompt(seeds, dateStr) {
  const failureSeedCount = seeds.filter((s) => Array.isArray(s && s.sources) && s.sources.includes('failure_memory')).length;
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
    failureSeedCount > 0 ? `Rules: include at least 1 failure-avoidance link when failure-memory seeds are present (${failureSeedCount}).` : '',
    `Context date: ${dateStr}`,
    `Seeds JSON: ${JSON.stringify(payload)}`
  ].filter(Boolean).join('\n');
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

  const budgetGate = assessDreamBudget(dateStr, 'idle', IDLE_REQUEST_TOKENS_EST);
  if (!budgetGate.allow) {
    return {
      ok: true,
      skipped: true,
      reason: String(budgetGate.reason || 'budget_guard_deny'),
      budget_guard: budgetGate.guard || null,
      budget_autopause: budgetGate.autopause || null
    };
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
  const failureSeedCount = seeds.filter((s) => Array.isArray(s && s.sources) && s.sources.includes('failure_memory')).length;

  const availableModels = listLocalModels(state);
  const blockedProviders = new Set();
  const pick = pickModelWithProviderExclusions(IDLE_MODEL_ORDER, availableModels, state, blockedProviders);
  if (!pick.model) {
    return {
      ok: false,
      skipped: true,
      reason: pick.skipped_models.length > 0 ? 'all_local_models_cooling_down' : 'no_local_model_available',
      seed_count: seeds.length,
      failure_seed_count: failureSeedCount,
      available_models: availableModels,
      cooling_models: pick.skipped_models
    };
  }

  const lease = requestSpawnLease('idle', IDLE_REQUEST_TOKENS_EST);
  if (!lease.ok) {
    return {
      ok: true,
      skipped: true,
      reason: String(lease.reason || 'spawn_budget_denied'),
      model: pick.model,
      spawn_budget: lease
    };
  }

  const prompt = buildIdlePrompt(seeds, dateStr);
  let release = null;
  try {
    const passStartedMs = Date.now();
    let passBudgetExceeded = false;
    const attemptedModels = [];
    let selectedModel = pick.model;
    while (selectedModel && attemptedModels.length < MODEL_MAX_MODELS_PER_PASS) {
      if (Date.now() - passStartedMs >= IDLE_PASS_MAX_MS) {
        passBudgetExceeded = true;
        break;
      }
      if (attemptedModels.some((it) => it.model === selectedModel)) break;
      const attemptRow = {
        model: selectedModel,
        preflight: null,
        attempts: []
      };
      attemptedModels.push(attemptRow);
      const preflight = runModelPreflight(state, selectedModel, 'idle');
      attemptRow.preflight = {
        enabled: MODEL_PREFLIGHT_ENABLED,
        ok: preflight.ok === true,
        skipped: preflight.skipped === true,
        reason: preflight.reason || null,
        cache_hit: preflight.cache_hit === true,
        cache_until_ts: preflight.cache_until_ts || null,
        timeout_ms: Number(preflight.timeout_ms || MODEL_PREFLIGHT_TIMEOUT_MS),
        code: preflight.llm && preflight.llm.code != null ? Number(preflight.llm.code) : null,
        signal: preflight.llm && preflight.llm.signal || null,
        timed_out: preflight.llm && preflight.llm.timed_out === true,
        error: preflight.llm && preflight.llm.error || null
      };
      if (!preflight.ok) {
        const llm = preflight.llm || {
          ok: false,
          stdout: '',
          stderr: preflight.reason || 'preflight_failed',
          code: 1,
          timed_out: false,
          signal: null,
          error: preflight.reason || 'preflight_failed'
        };
        const health = modelOnFailure(state, selectedModel, 'idle', llm);
        attemptRow.cooldown_until_ts = health && health.cooldown_until_ts || null;
        attemptRow.failure_reason = health && health.last_failure_reason || null;
        if (health && health.last_failure_reason === 'provider_unavailable') {
          blockedProviders.add(modelProviderKey(selectedModel));
        }
        const nextPick = pickModelWithProviderExclusions(IDLE_MODEL_ORDER, availableModels, state, blockedProviders);
        selectedModel = nextPick.model;
        continue;
      }
      const attempt = runModelWithRetries(selectedModel, prompt, LLM_TIMEOUT_MS, 'idle');
      attemptRow.attempts = Array.isArray(attempt.attempts) ? attempt.attempts : [];
      if (attempt.ok && attempt.llm && attempt.llm.ok === true) {
        const parsed = extractJsonObject(attempt.llm.stdout);
        const links = normalizeIdleLinks(parsed, seeds);
        const row = writeIdleRow(dateStr, selectedModel, seeds, links, parsed);
        modelOnSuccess(state, selectedModel, 'idle');
        return {
          ok: true,
          skipped: false,
          model: selectedModel,
          seed_count: seeds.length,
          failure_seed_count: failureSeedCount,
          link_count: links.length,
          row_uid: row.uid,
          attempted_models: attemptedModels,
          spawn_budget: {
            module: lease.module,
            granted_cells: lease.granted_cells
          }
        };
      }
      const llm = attempt && attempt.llm ? attempt.llm : {};
      const health = modelOnFailure(state, selectedModel, 'idle', llm);
      attemptRow.cooldown_until_ts = health && health.cooldown_until_ts || null;
      attemptRow.failure_reason = health && health.last_failure_reason || null;
      if (health && health.last_failure_reason === 'provider_unavailable') {
        blockedProviders.add(modelProviderKey(selectedModel));
      }
      const nextPick = pickModelWithProviderExclusions(IDLE_MODEL_ORDER, availableModels, state, blockedProviders);
      selectedModel = nextPick.model;
    }
    const passElapsedMs = Date.now() - passStartedMs;
    const lastAttempt = attemptedModels.length > 0 ? attemptedModels[attemptedModels.length - 1] : null;
    const lastTry = lastAttempt && Array.isArray(lastAttempt.attempts) && lastAttempt.attempts.length > 0
      ? lastAttempt.attempts[lastAttempt.attempts.length - 1]
      : {};
    const fallbackReason = passBudgetExceeded ? 'idle_pass_time_budget_exceeded' : 'all_model_attempts_failed';
    const links = normalizeIdleLinks(null, seeds);
    const row = writeIdleRow(dateStr, null, seeds, links, {
      strategy: 'deterministic_fallback',
      reason: fallbackReason,
      attempted_models: attemptedModels,
      pass_elapsed_ms: passElapsedMs,
      pass_budget_ms: IDLE_PASS_MAX_MS
    });
    return {
      ok: true,
      skipped: false,
      degraded: true,
      reason: 'deterministic_idle_fallback',
      fallback_reason: fallbackReason,
      failed_model: lastAttempt ? lastAttempt.model : null,
      fallback_model: null,
      cooldown_until_ts: lastAttempt && lastAttempt.cooldown_until_ts || null,
      code: Number(lastTry && lastTry.code != null ? lastTry.code : 1),
      signal: lastTry && lastTry.signal || null,
      timed_out: lastTry && lastTry.timed_out === true,
      error: lastTry && lastTry.error || null,
      stderr: String(lastTry && lastTry.stderr_tail || '').slice(-240),
      attempted_models: attemptedModels,
      pass_elapsed_ms: passElapsedMs,
      pass_budget_ms: IDLE_PASS_MAX_MS,
      seed_count: seeds.length,
      failure_seed_count: failureSeedCount,
      link_count: links.length,
      row_uid: row.uid
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
  const budgetGate = assessDreamBudget(dateStr, 'rem', requestedTokens);
  if (!budgetGate.allow) {
    return {
      ok: true,
      skipped: true,
      reason: String(budgetGate.reason || 'budget_guard_deny'),
      strategy,
      budget_guard: budgetGate.guard || null,
      budget_autopause: budgetGate.autopause || null
    };
  }
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

    const availableModels = listLocalModels(state);
    const blockedProviders = new Set();
    const pick = pickModelWithProviderExclusions(REM_MODEL_ORDER, availableModels, state, blockedProviders);
    if (!pick.model) {
      return {
        ok: false,
        skipped: true,
        reason: pick.skipped_models.length > 0 ? 'all_local_models_cooling_down_for_rem' : 'no_local_model_available_for_rem',
        strategy,
        available_models: availableModels,
        cooling_models: pick.skipped_models
      };
    }
    const prompt = buildRemPrompt(materialRows, dateStr);
    const passStartedMs = Date.now();
    let passBudgetExceeded = false;
    const attemptedModels = [];
    let selectedModel = pick.model;
    while (selectedModel && attemptedModels.length < MODEL_MAX_MODELS_PER_PASS) {
      if (Date.now() - passStartedMs >= REM_PASS_MAX_MS) {
        passBudgetExceeded = true;
        break;
      }
      if (attemptedModels.some((it) => it.model === selectedModel)) break;
      const attemptRow = {
        model: selectedModel,
        preflight: null,
        attempts: []
      };
      attemptedModels.push(attemptRow);
      const preflight = runModelPreflight(state, selectedModel, 'rem');
      attemptRow.preflight = {
        enabled: MODEL_PREFLIGHT_ENABLED,
        ok: preflight.ok === true,
        skipped: preflight.skipped === true,
        reason: preflight.reason || null,
        cache_hit: preflight.cache_hit === true,
        cache_until_ts: preflight.cache_until_ts || null,
        timeout_ms: Number(preflight.timeout_ms || MODEL_PREFLIGHT_TIMEOUT_MS),
        code: preflight.llm && preflight.llm.code != null ? Number(preflight.llm.code) : null,
        signal: preflight.llm && preflight.llm.signal || null,
        timed_out: preflight.llm && preflight.llm.timed_out === true,
        error: preflight.llm && preflight.llm.error || null
      };
      if (!preflight.ok) {
        const llm = preflight.llm || {
          ok: false,
          stdout: '',
          stderr: preflight.reason || 'preflight_failed',
          code: 1,
          timed_out: false,
          signal: null,
          error: preflight.reason || 'preflight_failed'
        };
        const health = modelOnFailure(state, selectedModel, 'rem', llm);
        attemptRow.cooldown_until_ts = health && health.cooldown_until_ts || null;
        attemptRow.failure_reason = health && health.last_failure_reason || null;
        if (health && health.last_failure_reason === 'provider_unavailable') {
          blockedProviders.add(modelProviderKey(selectedModel));
        }
        const nextPick = pickModelWithProviderExclusions(REM_MODEL_ORDER, availableModels, state, blockedProviders);
        selectedModel = nextPick.model;
        continue;
      }
      const attempt = runModelWithRetries(selectedModel, prompt, REM_TIMEOUT_MS, 'rem');
      attemptRow.attempts = Array.isArray(attempt.attempts) ? attempt.attempts : [];
      if (attempt.ok && attempt.llm && attempt.llm.ok === true) {
        const parsed = extractJsonObject(attempt.llm.stdout);
        const quantized = normalizeQuantized(parsed, materialRows);
        const rem = writeRemResult(dateStr, selectedModel, materialRows, quantized, parsed);
        modelOnSuccess(state, selectedModel, 'rem');
        return {
          ok: true,
          skipped: false,
          strategy,
          model: selectedModel,
          source_idle_rows: materialRows.length,
          quantized_count: quantized.length,
          rem_uid: rem.uid,
          attempted_models: attemptedModels,
          spawn_budget: {
            module: lease.module,
            granted_cells: lease.granted_cells
          }
        };
      }
      const llm = attempt && attempt.llm ? attempt.llm : {};
      const health = modelOnFailure(state, selectedModel, 'rem', llm);
      attemptRow.cooldown_until_ts = health && health.cooldown_until_ts || null;
      attemptRow.failure_reason = health && health.last_failure_reason || null;
      if (health && health.last_failure_reason === 'provider_unavailable') {
        blockedProviders.add(modelProviderKey(selectedModel));
      }
      const nextPick = pickModelWithProviderExclusions(REM_MODEL_ORDER, availableModels, state, blockedProviders);
      selectedModel = nextPick.model;
    }
    const passElapsedMs = Date.now() - passStartedMs;
    const lastAttempt = attemptedModels.length > 0 ? attemptedModels[attemptedModels.length - 1] : null;
    const lastTry = lastAttempt && Array.isArray(lastAttempt.attempts) && lastAttempt.attempts.length > 0
      ? lastAttempt.attempts[lastAttempt.attempts.length - 1]
      : {};
    const fallbackReason = passBudgetExceeded ? 'rem_pass_time_budget_exceeded' : 'all_model_attempts_failed';
    const quantized = fallbackQuantized(materialRows);
    const rem = writeRemResult(dateStr, null, materialRows, quantized, {
      strategy: 'deterministic_fallback',
      reason: fallbackReason,
      attempted_models: attemptedModels,
      pass_elapsed_ms: passElapsedMs,
      pass_budget_ms: REM_PASS_MAX_MS
    });
    return {
      ok: true,
      skipped: false,
      degraded: true,
      reason: 'deterministic_rem_fallback',
      fallback_reason: fallbackReason,
      strategy,
      failed_model: lastAttempt ? lastAttempt.model : null,
      cooldown_until_ts: lastAttempt && lastAttempt.cooldown_until_ts || null,
      model: null,
      code: Number(lastTry && lastTry.code != null ? lastTry.code : 1),
      signal: lastTry && lastTry.signal || null,
      timed_out: lastTry && lastTry.timed_out === true,
      error: lastTry && lastTry.error || null,
      stderr: String(lastTry && lastTry.stderr_tail || '').slice(-240),
      attempted_models: attemptedModels,
      pass_elapsed_ms: passElapsedMs,
      pass_budget_ms: REM_PASS_MAX_MS,
      source_idle_rows: materialRows.length,
      quantized_count: quantized.length,
      rem_uid: rem.uid
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

function shouldEmitDreamPain(phase, result) {
  if (!result || typeof result !== 'object') return false;
  const reason = String(result.fallback_reason || result.reason || result.error || '').toLowerCase();
  if (result.degraded === true) {
    const fallbackOutput = Number(result.link_count || result.quantized_count || 0);
    const localUnavailable = (
      reason.includes('all_local_models_cooling_down')
      || reason.includes('no_local_model_available')
      || reason.includes('all_model_attempts_failed')
      || reason.includes('preflight_failed')
      || reason.includes('provider_unavailable')
    );
    if (localUnavailable && fallbackOutput > 0) return false;
    return true;
  }
  if (result.ok === false) return true;
  if (result.skipped === true) {
    if (
      reason.includes('all_local_models_cooling_down')
      || reason.includes('no_local_model_available')
      || reason.includes('all_model_attempts_failed')
      || reason.includes('preflight_failed')
      || reason.includes('provider_unavailable')
      || reason.includes('timeout')
    ) return true;
  }
  return false;
}

function normalizeDreamPainReason(reasonRaw) {
  const r = normalizeToken(String(reasonRaw || '').toLowerCase()) || 'dream_failure';
  if (
    r.includes('all_local_models_cooling_down')
    || r.includes('no_local_model_available')
    || r.includes('all_model_attempts_failed')
    || r.includes('preflight_failed')
    || r.includes('provider_unavailable')
  ) return 'local_model_unavailable';
  if (r.includes('timeout')) return 'model_timeout';
  return r;
}

function resolveDreamPainProposals(dateStr, phase, resolutionReason) {
  const filePath = path.join(REPO_ROOT, 'state', 'sensory', 'proposals', `${dateStr}.json`);
  if (!fs.existsSync(filePath)) return 0;
  const rows = readJsonSafe(filePath, []);
  if (!Array.isArray(rows) || rows.length === 0) return 0;
  let changed = false;
  let resolved = 0;
  const phasePrefixRaw = `dream_${normalizeToken(phase) || 'phase'}:`;
  const phasePrefixNorm = `dream_${normalizeToken(phase) || 'phase'}_`;
  const next = rows.map((p) => {
    if (!p || typeof p !== 'object') return p;
    if (String(p.type || '').trim().toLowerCase() !== 'dream_cycle_escalation') return p;
    const status = String(p.status || '').trim().toLowerCase();
    if (status === 'resolved' || status === 'done' || status === 'closed') return p;
    const meta = p.meta && typeof p.meta === 'object' ? p.meta : {};
    const codeRaw = String(meta.pain_code || '').trim().toLowerCase();
    const codeNorm = normalizeToken(codeRaw);
    if (codeRaw) {
      const matchesPhase = codeRaw.startsWith(phasePrefixRaw) || codeNorm.startsWith(phasePrefixNorm);
      if (!matchesPhase) return p;
    }
    changed = true;
    resolved += 1;
    return {
      ...p,
      status: 'resolved',
      resolved_at: nowIso(),
      resolution_reason: normalizeText(resolutionReason, 'dream_cycle_fallback_success').slice(0, 140)
    };
  });
  if (changed) writeJson(filePath, next);
  return resolved;
}

function emitDreamPainSignal(dateStr, phase, result) {
  if (!shouldEmitDreamPain(phase, result)) {
    return { emitted: false, reason: 'not_actionable' };
  }
  const reasonRaw = String(result.fallback_reason || result.reason || result.error || 'dream_failure').toLowerCase();
  const reasonToken = normalizeDreamPainReason(reasonRaw);
  const failedModel = normalizeText(result.failed_model || result.model || '');
  const code = `dream_${normalizeToken(phase) || 'phase'}:${reasonToken}`;
  const summary = `Dream ${phase} phase degraded or blocked (${reasonToken})`;
  const details = [
    `ok=${result.ok === true}`,
    `skipped=${result.skipped === true}`,
    `degraded=${result.degraded === true}`,
    `failed_model=${failedModel || 'none'}`,
    `timed_out=${result.timed_out === true}`,
    `cooldown_until=${normalizeText(result.cooldown_until_ts, 'none')}`
  ].join(' ');
  const suggestedNextCommand = `node systems/memory/idle_dream_cycle.js run ${dateStr} --force=1`;
  const out = emitPainSignal({
    ts: nowIso(),
    source: 'idle_dream_cycle',
    subsystem: 'memory',
    code,
    summary,
    details: details.slice(0, 800),
    severity: result.degraded === true ? 'medium' : 'high',
    risk: 'medium',
    proposal_type: 'dream_cycle_escalation',
    suggested_next_command: suggestedNextCommand,
    window_hours: Number(process.env.IDLE_DREAM_PAIN_WINDOW_HOURS || 12),
    escalate_after: Number(process.env.IDLE_DREAM_PAIN_ESCALATE_AFTER || 2),
    cooldown_hours: Number(process.env.IDLE_DREAM_PAIN_COOLDOWN_HOURS || 6),
    signature_extra: `${phase}|${reasonToken}`,
    evidence: [
      {
        source: 'idle_dream_cycle',
        path: path.relative(REPO_ROOT, LEDGER_PATH).replace(/\\/g, '/'),
        match: `phase=${phase} reason=${reasonToken}`.slice(0, 120),
        evidence_ref: `dream:${phase}:${reasonToken}`
      }
    ]
  });
  appendJsonl(LEDGER_PATH, {
    ts: nowIso(),
    type: 'idle_dream_pain_signal',
    phase,
    code,
    summary,
    reason: reasonToken,
    escalation: out && out.escalation ? out.escalation : null
  });
  return out && out.escalation
    ? { emitted: out.escalation.emitted === true, proposal_id: out.escalation.proposal_id || null, reason: out.escalation.reason || null }
    : { emitted: false, reason: 'emit_failed' };
}

function runCycle(dateStr, opts = {}) {
  const provenance = enforceMutationProvenance('memory', {
    source: SCRIPT_SOURCE,
    reason: 'idle_dream_cycle_run'
  }, {
    fallbackSource: SCRIPT_SOURCE,
    defaultReason: 'idle_dream_cycle_run',
    context: `run:${dateStr}`
  });
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
  const idlePain = emitDreamPainSignal(dateStr, 'idle', idleResult);
  const remPain = emitDreamPainSignal(dateStr, 'rem', remResult);
  const painResolution = { idle: 0, rem: 0 };
  if (
    idlePain && idlePain.emitted !== true
    && idleResult && idleResult.ok === true
    && idleResult.skipped !== true
    && Number(idleResult.link_count || 0) > 0
  ) {
    painResolution.idle = resolveDreamPainProposals(dateStr, 'idle', 'dream_idle_fallback_success');
  }
  if (
    remPain && remPain.emitted !== true
    && remResult && remResult.ok === true
    && remResult.skipped !== true
    && Number(remResult.quantized_count || 0) > 0
  ) {
    painResolution.rem = resolveDreamPainProposals(dateStr, 'rem', 'dream_rem_fallback_success');
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
    pain_signals: {
      idle: idlePain,
      rem: remPain
    },
    pain_resolution: painResolution,
    state: {
      last_idle_ts: state.last_idle_ts,
      last_rem_ts: state.last_rem_ts,
      idle_runs: state.idle_runs,
      rem_runs: state.rem_runs,
      idle_runs_since_rem: state.idle_runs_since_rem,
      last_idle_model: state.last_idle_model,
      last_rem_model: state.last_rem_model,
      model_health: state.model_health || {}
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
    pain_resolved_idle: Number(painResolution.idle || 0),
    pain_resolved_rem: Number(painResolution.rem || 0),
    idle_runs_before: Number(before.idle_runs || 0),
    idle_runs_after: Number(state.idle_runs || 0),
    rem_runs_before: Number(before.rem_runs || 0),
    rem_runs_after: Number(state.rem_runs || 0)
  });
  recordMutationAudit('memory', {
    type: 'controller_run',
    controller: SCRIPT_SOURCE,
    operation: 'idle_dream_cycle_run',
    source: provenance.meta && provenance.meta.source || SCRIPT_SOURCE,
    reason: provenance.meta && provenance.meta.reason || 'idle_dream_cycle_run',
    provenance_ok: provenance.ok === true,
    provenance_violations: Array.isArray(provenance.violations) ? provenance.violations : [],
    files_touched: [
      path.relative(REPO_ROOT, STATE_PATH).replace(/\\/g, '/'),
      path.relative(REPO_ROOT, LEDGER_PATH).replace(/\\/g, '/'),
      path.relative(REPO_ROOT, path.join(IDLE_DIR, `${dateStr}.jsonl`)).replace(/\\/g, '/'),
      path.relative(REPO_ROOT, path.join(REM_DIR, `${dateStr}.json`)).replace(/\\/g, '/')
    ],
    metrics: {
      force,
      rem_only: remOnly,
      idle_ok: !!(idleResult && idleResult.ok),
      idle_skipped: !!(idleResult && idleResult.skipped),
      rem_ok: !!(remResult && remResult.ok),
      rem_skipped: !!(remResult && remResult.skipped)
    }
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
    rem_quantized_today: remToday && Array.isArray(remToday.quantized) ? remToday.quantized.length : 0,
    active_model_cooldowns: Object.entries(state.model_health || {})
      .map(([model, row]) => ({ model, row }))
      .filter((it) => {
        const ms = Date.parse(String(it.row && it.row.cooldown_until_ts || ''));
        return Number.isFinite(ms) && ms > Date.now();
      })
      .map((it) => ({
        model: it.model,
        cooldown_until_ts: it.row.cooldown_until_ts || null,
        failure_streak: Number(it.row.failure_streak || 0),
        last_failure_reason: it.row.last_failure_reason || null
      }))
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
