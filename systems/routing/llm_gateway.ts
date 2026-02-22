#!/usr/bin/env node
'use strict';

/**
 * llm_gateway.js
 *
 * Centralized local-LLM execution gateway for runtime callers.
 * - Consolidates direct `ollama run` usage behind one module.
 * - Emits deterministic call telemetry for audit and budgeting loops.
 *
 * This file is intentionally low-level and side-effect free except for:
 * - invoking `ollama`
 * - appending JSONL telemetry (can be disabled via env)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const GATEWAY_LOG_PATH = process.env.LLM_GATEWAY_LOG_PATH
  ? path.resolve(String(process.env.LLM_GATEWAY_LOG_PATH))
  : path.join(REPO_ROOT, 'state', 'routing', 'llm_gateway_calls.jsonl');
const GATEWAY_LOG_ENABLED = String(process.env.LLM_GATEWAY_LOG_ENABLED || '1').trim() !== '0';
const PROMPT_CACHE_ENABLED = String(process.env.LLM_GATEWAY_PROMPT_CACHE_ENABLED || '1').trim() !== '0';
const PROMPT_CACHE_DIR = process.env.LLM_GATEWAY_PROMPT_CACHE_DIR
  ? path.resolve(String(process.env.LLM_GATEWAY_PROMPT_CACHE_DIR))
  : path.join(REPO_ROOT, 'state', 'routing', 'prompt_result_cache');
const PROMPT_CACHE_INDEX_PATH = path.join(PROMPT_CACHE_DIR, 'index.json');
const PROMPT_CACHE_TTL_MS = Math.max(5000, Number(process.env.LLM_GATEWAY_PROMPT_CACHE_TTL_MS || (30 * 60 * 1000)));
const PROMPT_CACHE_MAX_ENTRIES = Math.max(50, Number(process.env.LLM_GATEWAY_PROMPT_CACHE_MAX_ENTRIES || 600));
const PROMPT_CACHE_INVALIDATION_PATH = process.env.LLM_GATEWAY_PROMPT_CACHE_INVALIDATION_PATH
  ? path.resolve(String(process.env.LLM_GATEWAY_PROMPT_CACHE_INVALIDATION_PATH))
  : path.join(REPO_ROOT, 'state', 'routing', 'prompt_cache_invalidation.json');

function nowIso() {
  return new Date().toISOString();
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function appendJsonl(filePath, obj) {
  if (!GATEWAY_LOG_ENABLED) return;
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, JSON.stringify(obj) + '\n', 'utf8');
}

function readJsonSafe(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, obj) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), 'utf8');
}

function stripAnsi(v) {
  return String(v || '')
    .replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/[\u2800-\u28ff]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeModelName(v) {
  const raw = String(v || '').trim().replace(/^ollama\//, '').toLowerCase();
  if (raw.endsWith(':latest')) return raw.slice(0, -(':latest'.length));
  return raw;
}

function normalizePrompt(v) {
  return String(v || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 8000);
}

function promptCacheFingerprint(parts: Record<string, any>) {
  const keyPayload = JSON.stringify({
    model: normalizeModelName(parts.model),
    phase: String(parts.phase || ''),
    source: String(parts.source || ''),
    source_fingerprint: String(parts.source_fingerprint || ''),
    prompt: normalizePrompt(parts.prompt || ''),
    bust: String(process.env.LLM_GATEWAY_PROMPT_CACHE_BUST || '')
  });
  return crypto.createHash('sha256').update(keyPayload).digest('hex');
}

function promptCachePathForKey(key: string) {
  return path.join(PROMPT_CACHE_DIR, `${String(key || '').slice(0, 64)}.json`);
}

function promptCacheInvalidation() {
  const raw = readJsonSafe(PROMPT_CACHE_INVALIDATION_PATH, null);
  if (!raw || typeof raw !== 'object') return { invalidate_before_ts: null };
  const ts = String(raw.invalidate_before_ts || '').trim();
  return {
    invalidate_before_ts: ts && !isNaN(Date.parse(ts)) ? ts : null
  };
}

function loadPromptCacheIndex() {
  const raw = readJsonSafe(PROMPT_CACHE_INDEX_PATH, null);
  if (raw && typeof raw === 'object' && raw.entries && typeof raw.entries === 'object') {
    return raw;
  }
  return {
    version: 1,
    updated_at: nowIso(),
    entries: {}
  };
}

function savePromptCacheIndex(index: Record<string, any>) {
  index.updated_at = nowIso();
  writeJson(PROMPT_CACHE_INDEX_PATH, index);
}

function prunePromptCacheIndex(index: Record<string, any>, nowMs = Date.now()) {
  const invalidation = promptCacheInvalidation();
  const invalidBeforeMs = invalidation.invalidate_before_ts
    ? Date.parse(invalidation.invalidate_before_ts)
    : null;
  const entries = index.entries && typeof index.entries === 'object' ? index.entries : {};
  const keep: Record<string, any> = {};
  const ordered = Object.entries(entries)
    .map(([k, v]) => [k, v && typeof v === 'object' ? v : {}] as [string, Record<string, any>])
    .sort((a, b) => Number((b[1] && b[1].last_hit_ms) || 0) - Number((a[1] && a[1].last_hit_ms) || 0));
  let kept = 0;
  for (const [key, ent] of ordered) {
    if (kept >= PROMPT_CACHE_MAX_ENTRIES) continue;
    const expiresMs = Number(ent.expires_ms || 0);
    if (expiresMs && nowMs > expiresMs) continue;
    if (invalidBeforeMs && Number.isFinite(invalidBeforeMs)) {
      const createdMs = Number(ent.created_ms || 0);
      if (createdMs > 0 && createdMs < invalidBeforeMs) continue;
    }
    const cachePath = promptCachePathForKey(key);
    if (!fs.existsSync(cachePath)) continue;
    keep[key] = ent;
    kept += 1;
  }
  index.entries = keep;
  return index;
}

function readPromptCache(key: string, nowMs = Date.now()) {
  if (!PROMPT_CACHE_ENABLED) return null;
  const index = prunePromptCacheIndex(loadPromptCacheIndex(), nowMs);
  const ent = index.entries && index.entries[key];
  if (!ent || typeof ent !== 'object') {
    savePromptCacheIndex(index);
    return null;
  }
  const expiresMs = Number(ent.expires_ms || 0);
  if (expiresMs && nowMs > expiresMs) {
    delete index.entries[key];
    savePromptCacheIndex(index);
    return null;
  }
  const cachePath = promptCachePathForKey(key);
  const row = readJsonSafe(cachePath, null);
  if (!row || typeof row !== 'object') {
    delete index.entries[key];
    savePromptCacheIndex(index);
    return null;
  }
  ent.hits = Number(ent.hits || 0) + 1;
  ent.last_hit_ms = nowMs;
  index.entries[key] = ent;
  savePromptCacheIndex(index);
  return row;
}

function writePromptCache(key: string, payload: Record<string, any>, nowMs = Date.now()) {
  if (!PROMPT_CACHE_ENABLED) return;
  const ttlMs = Math.max(1000, Number(payload.ttl_ms || PROMPT_CACHE_TTL_MS));
  const cachePath = promptCachePathForKey(key);
  const expiresMs = nowMs + ttlMs;
  writeJson(cachePath, {
    ...payload,
    ts: nowIso(),
    expires_at: new Date(expiresMs).toISOString()
  });
  const index = prunePromptCacheIndex(loadPromptCacheIndex(), nowMs);
  index.entries[key] = {
    key,
    model: normalizeModelName(payload.model),
    phase: String(payload.phase || ''),
    source: String(payload.source || ''),
    source_fingerprint: String(payload.source_fingerprint || ''),
    created_ms: nowMs,
    last_hit_ms: nowMs,
    hits: Number(index.entries[key] && index.entries[key].hits || 0),
    ttl_ms: ttlMs,
    expires_ms: expiresMs
  };
  savePromptCacheIndex(index);
}

function isUnknownFlagError(text) {
  return /\b(unknown flag|unknown shorthand|unknown option|unknown command|flag provided but not defined|invalid option)\b/i
    .test(String(text || ''));
}

function listLocalOllamaModels(opts = {}) {
  const o = (opts && typeof opts === 'object' ? opts : {}) as Record<string, any>;
  const timeoutMs = Number.isFinite(Number(o.timeoutMs)) ? Number(o.timeoutMs) : 5000;
  const cwd = o.cwd ? String(o.cwd) : REPO_ROOT;
  const source = String(o.source || 'llm_gateway').trim() || 'llm_gateway';
  const started = Date.now();
  const r = spawnSync('ollama', ['list'], { encoding: 'utf8', timeout: timeoutMs, cwd });
  const latencyMs = Date.now() - started;
  if (r.status !== 0) {
    appendJsonl(GATEWAY_LOG_PATH, {
      ts: nowIso(),
      type: 'llm_gateway_list',
      ok: false,
      source,
      latency_ms: latencyMs,
      code: r.status == null ? 1 : r.status,
      stderr: stripAnsi(r.stderr || '').slice(-240)
    });
    return {
      ok: false,
      models: [],
      latency_ms: latencyMs,
      code: r.status == null ? 1 : r.status,
      stderr: stripAnsi(r.stderr || '')
    };
  }

  const lines = String(r.stdout || '').split(/\r?\n/).filter(Boolean);
  const out = [];
  for (const line of lines.slice(1)) {
    const first = String(line || '').trim().split(/\s+/)[0];
    const clean = normalizeModelName(first);
    if (clean) out.push(clean);
  }
  const models = Array.from(new Set(out));
  appendJsonl(GATEWAY_LOG_PATH, {
    ts: nowIso(),
    type: 'llm_gateway_list',
    ok: true,
    source,
    latency_ms: latencyMs,
    model_count: models.length
  });
  return {
    ok: true,
    models,
    latency_ms: latencyMs
  };
}

function runOllamaPromptRaw(model, prompt, timeoutMs, extraArgs = [], cwd = REPO_ROOT) {
  const args = ['run', model, ...extraArgs, prompt];
  const started = Date.now();
  const r = spawnSync('ollama', args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    cwd
  });
  const errorText = r.error ? String(r.error) : '';
  return {
    ok: r.status === 0,
    stdout: stripAnsi(r.stdout || ''),
    stderr: stripAnsi(r.stderr || ''),
    code: r.status == null ? 1 : r.status,
    signal: r.signal || null,
    timed_out: /\bETIMEDOUT\b/i.test(errorText),
    error: errorText || null,
    latency_ms: Date.now() - started
  };
}

function runLocalOllamaPrompt(opts = {}) {
  const o = (opts && typeof opts === 'object' ? opts : {}) as Record<string, any>;
  const model = normalizeModelName(o.model);
  const prompt = String(o.prompt || '');
  const timeoutMs = Number.isFinite(Number(o.timeoutMs)) ? Number(o.timeoutMs) : 25000;
  const phase = String(o.phase || 'general').trim() || 'general';
  const source = String(o.source || 'llm_gateway').trim() || 'llm_gateway';
  const cwd = o.cwd ? String(o.cwd) : REPO_ROOT;
  const allowFlagFallback = o.allowFlagFallback !== false;
  const sourceFingerprint = String(o.source_fingerprint || o.cache_source_fingerprint || '').trim();
  const cacheAllowed = PROMPT_CACHE_ENABLED && o.use_cache !== false;
  const cacheTtlMs = Number.isFinite(Number(o.cache_ttl_ms)) ? Number(o.cache_ttl_ms) : PROMPT_CACHE_TTL_MS;

  if (!model) {
    return { ok: false, stdout: '', stderr: 'no_local_model_selected', code: 2, signal: null, timed_out: false, error: null, latency_ms: 0 };
  }

  const cacheKey = promptCacheFingerprint({
    model,
    prompt,
    phase,
    source,
    source_fingerprint: sourceFingerprint
  });
  const cacheStart = Date.now();
  if (cacheAllowed) {
    const cached = readPromptCache(cacheKey, cacheStart);
    if (cached && typeof cached === 'object') {
      const latencyMs = Date.now() - cacheStart;
      appendJsonl(GATEWAY_LOG_PATH, {
        ts: nowIso(),
        type: 'llm_gateway_run',
        ok: true,
        source,
        phase,
        model,
        timeout_ms: timeoutMs,
        latency_ms: latencyMs,
        code: 0,
        signal: null,
        timed_out: false,
        fallback_attempted: false,
        cache_hit: true,
        cache_key: cacheKey.slice(0, 16)
      });
      return {
        ok: true,
        stdout: String(cached.stdout || ''),
        stderr: String(cached.stderr || ''),
        code: Number(cached.code || 0),
        signal: cached.signal || null,
        timed_out: false,
        error: null,
        latency_ms: latencyMs,
        model,
        phase,
        fallback_attempted: false,
        cache_hit: true,
        cache_key: cacheKey
      };
    }
  }

  const primary = runOllamaPromptRaw(model, prompt, timeoutMs, ['--hidethinking', '--nowordwrap'], cwd);
  let final = primary;
  let fallbackAttempted = false;
  if (!primary.ok && allowFlagFallback && (isUnknownFlagError(primary.stderr) || isUnknownFlagError(primary.error))) {
    fallbackAttempted = true;
    const fallback = runOllamaPromptRaw(model, prompt, timeoutMs, [], cwd);
    final = fallback;
  }

  appendJsonl(GATEWAY_LOG_PATH, {
    ts: nowIso(),
    type: 'llm_gateway_run',
    ok: final.ok === true,
    source,
    phase,
    model,
    timeout_ms: timeoutMs,
    latency_ms: Number(final.latency_ms || 0),
    code: final.code,
    signal: final.signal || null,
    timed_out: final.timed_out === true,
    fallback_attempted: fallbackAttempted,
    cache_hit: false,
    cache_key: cacheKey.slice(0, 16),
    stderr_tail: String(final.stderr || '').slice(-180)
  });

  if (cacheAllowed && final.ok === true && final.timed_out !== true) {
    writePromptCache(cacheKey, {
      model,
      phase,
      source,
      source_fingerprint: sourceFingerprint,
      stdout: String(final.stdout || ''),
      stderr: String(final.stderr || ''),
      code: Number(final.code || 0),
      signal: final.signal || null,
      ttl_ms: cacheTtlMs
    });
  }

  return {
    ...final,
    model,
    phase,
    fallback_attempted: fallbackAttempted,
    cache_hit: false,
    cache_key: cacheKey
  };
}

module.exports = {
  listLocalOllamaModels,
  runLocalOllamaPrompt,
  stripAnsi,
  isUnknownFlagError,
  normalizeModelName
};
export {};
