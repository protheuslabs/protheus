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
const TEST_OPACITY_POLICY_PATH = process.env.LLM_TEST_OPACITY_POLICY_PATH
  ? path.resolve(String(process.env.LLM_TEST_OPACITY_POLICY_PATH))
  : path.join(REPO_ROOT, 'config', 'llm_test_opacity_policy.json');

let TEST_OPACITY_POLICY_CACHE: Record<string, any> = {
  path: null,
  mtime_ms: null,
  value: null
};

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

function appendJsonlAlways(filePath, obj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, JSON.stringify(obj) + '\n', 'utf8');
}

function resolveRepoPath(rawPath, fallbackPath) {
  const candidate = String(rawPath || '').trim();
  if (!candidate) return fallbackPath;
  if (path.isAbsolute(candidate)) return candidate;
  return path.join(REPO_ROOT, candidate);
}

function clampInt(v, lo, hi, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

function safeRegexFromString(rawPattern) {
  const p = String(rawPattern || '').trim();
  if (!p) return null;
  try {
    return new RegExp(p, 'i');
  } catch {
    return null;
  }
}

function uniqueLowerList(rows, maxItems = 128) {
  const src = Array.isArray(rows) ? rows : [];
  const out = [];
  const seen = new Set();
  for (const row of src) {
    const next = String(row || '').trim().toLowerCase();
    if (!next || seen.has(next)) continue;
    seen.add(next);
    out.push(next);
    if (out.length >= maxItems) break;
  }
  return out;
}

function defaultTestOpacityPolicy() {
  const statePath = path.join(REPO_ROOT, 'state', 'security', 'llm_test_opacity', 'state.json');
  const incidentLogPath = path.join(REPO_ROOT, 'state', 'security', 'llm_test_opacity', 'incidents.jsonl');
  return {
    version: '1.0',
    enabled: true,
    state_path: statePath,
    incident_log_path: incidentLogPath,
    block_response: {
      stderr: 'test_opacity_blocked',
      error: 'test_opacity_blocked'
    },
    blocked_path_patterns: [
      String.raw`(?:^|[\\/])memory[\\/]tools[\\/]tests(?:[\\/]|$)`,
      String.raw`(?:^|[\\/])tests(?:[\\/]|$)`,
      String.raw`(?:^|[\\/])config[\\/].*test`,
      String.raw`\.test\.(?:js|ts)\b`,
      String.raw`autonomy_simulation_harness`,
      String.raw`red_team_harness`,
      String.raw`maturity_harness`,
      String.raw`shadow_pass_gate`
    ],
    blocked_intent_patterns: [
      String.raw`(?:reveal|show|print|dump|explain)\b.{0,120}\b(?:test|harness|rubric|scoring|criteria|oracle|judge)`,
      String.raw`\b(?:hidden|private|internal|opaque)\b.{0,120}\b(?:test|harness|criteria|rubric|oracle|judge)`,
      String.raw`\b(?:reverse(?:\s|-)?engineer|brute(?:\s|-)?force|game)\b.{0,160}\b(?:test|harness|criteria|rubric|oracle|judge)`
    ],
    anti_reverse_engineering: {
      enabled: true,
      window_seconds: 900,
      max_blocked_attempts_per_window: 4,
      max_unique_signatures_per_window: 3,
      max_global_blocked_attempts_per_window: 20,
      lockout_seconds: 1800,
      suspicious_terms: [
        'hidden test',
        'test harness',
        'rubric',
        'scoring criteria',
        'judge function',
        'reverse engineer',
        'brute force',
        'game the test',
        'oracle'
      ]
    }
  };
}

function normalizeTestOpacityPolicy(rawPolicy) {
  const base = defaultTestOpacityPolicy();
  const src = rawPolicy && typeof rawPolicy === 'object' ? rawPolicy : {};
  const antiSrc = src.anti_reverse_engineering && typeof src.anti_reverse_engineering === 'object'
    ? src.anti_reverse_engineering
    : {};
  const blockResponse = src.block_response && typeof src.block_response === 'object'
    ? src.block_response
    : {};

  const out: Record<string, any> = {
    version: String(src.version || base.version),
    enabled: src.enabled !== false,
    state_path: resolveRepoPath(src.state_path, base.state_path),
    incident_log_path: resolveRepoPath(src.incident_log_path, base.incident_log_path),
    block_response: {
      stderr: String(blockResponse.stderr || base.block_response.stderr),
      error: String(blockResponse.error || base.block_response.error)
    },
    blocked_path_patterns: Array.isArray(src.blocked_path_patterns) && src.blocked_path_patterns.length
      ? src.blocked_path_patterns.map((x) => String(x || '')).filter(Boolean).slice(0, 128)
      : base.blocked_path_patterns.slice(),
    blocked_intent_patterns: Array.isArray(src.blocked_intent_patterns) && src.blocked_intent_patterns.length
      ? src.blocked_intent_patterns.map((x) => String(x || '')).filter(Boolean).slice(0, 128)
      : base.blocked_intent_patterns.slice(),
    anti_reverse_engineering: {
      enabled: antiSrc.enabled !== false,
      window_seconds: clampInt(
        antiSrc.window_seconds,
        10,
        24 * 60 * 60,
        base.anti_reverse_engineering.window_seconds
      ),
      max_blocked_attempts_per_window: clampInt(
        antiSrc.max_blocked_attempts_per_window,
        1,
        1000,
        base.anti_reverse_engineering.max_blocked_attempts_per_window
      ),
      max_unique_signatures_per_window: clampInt(
        antiSrc.max_unique_signatures_per_window,
        1,
        1000,
        base.anti_reverse_engineering.max_unique_signatures_per_window
      ),
      max_global_blocked_attempts_per_window: clampInt(
        antiSrc.max_global_blocked_attempts_per_window,
        1,
        100000,
        base.anti_reverse_engineering.max_global_blocked_attempts_per_window
      ),
      lockout_seconds: clampInt(
        antiSrc.lockout_seconds,
        10,
        24 * 60 * 60,
        base.anti_reverse_engineering.lockout_seconds
      ),
      suspicious_terms: uniqueLowerList(
        Array.isArray(antiSrc.suspicious_terms)
          ? antiSrc.suspicious_terms
          : base.anti_reverse_engineering.suspicious_terms,
        128
      )
    }
  };
  out._blocked_path_regex = out.blocked_path_patterns.map((x) => safeRegexFromString(x)).filter(Boolean);
  out._blocked_intent_regex = out.blocked_intent_patterns.map((x) => safeRegexFromString(x)).filter(Boolean);
  return out;
}

function loadTestOpacityPolicy() {
  const fp = TEST_OPACITY_POLICY_PATH;
  const mtimeMs = fs.existsSync(fp)
    ? Number(fs.statSync(fp).mtimeMs || 0)
    : -1;
  if (
    TEST_OPACITY_POLICY_CACHE
    && TEST_OPACITY_POLICY_CACHE.path === fp
    && TEST_OPACITY_POLICY_CACHE.mtime_ms === mtimeMs
    && TEST_OPACITY_POLICY_CACHE.value
  ) {
    return TEST_OPACITY_POLICY_CACHE.value;
  }
  const raw = readJsonSafe(fp, null);
  const normalized = normalizeTestOpacityPolicy(raw);
  TEST_OPACITY_POLICY_CACHE = {
    path: fp,
    mtime_ms: mtimeMs,
    value: normalized
  };
  return normalized;
}

function normalizePromptForSecurity(v) {
  return String(v || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 12000);
}

function regexHitStrings(text, regexes) {
  const out = [];
  for (const rx of Array.isArray(regexes) ? regexes : []) {
    if (!rx || typeof rx.test !== 'function') continue;
    try {
      if (rx.test(text)) out.push(String(rx.source || rx));
    } catch {
      // no-op
    }
    if (out.length >= 24) break;
  }
  return out;
}

function pruneTimedRows(rows, cutoffMs) {
  const src = Array.isArray(rows) ? rows : [];
  return src.filter((row) => {
    const ts = Date.parse(String(row && row.ts || ''));
    return Number.isFinite(ts) && ts >= cutoffMs;
  }).slice(-2048);
}

function hashPromptSignature(normalizedPrompt) {
  return crypto
    .createHash('sha256')
    .update(String(normalizedPrompt || ''), 'utf8')
    .digest('hex')
    .slice(0, 24);
}

function loadOpacityState(policy) {
  const fallback = {
    schema_id: 'llm_test_opacity_state',
    schema_version: '1.0',
    updated_at: nowIso(),
    sources: {},
    global_blocked_attempts: []
  };
  const raw = readJsonSafe(policy.state_path, fallback);
  const src = raw && typeof raw === 'object' ? raw : fallback;
  return {
    schema_id: 'llm_test_opacity_state',
    schema_version: '1.0',
    updated_at: String(src.updated_at || nowIso()),
    sources: src.sources && typeof src.sources === 'object' ? src.sources : {},
    global_blocked_attempts: Array.isArray(src.global_blocked_attempts) ? src.global_blocked_attempts : []
  };
}

function saveOpacityState(policy, state) {
  const out = {
    schema_id: 'llm_test_opacity_state',
    schema_version: '1.0',
    updated_at: nowIso(),
    sources: state && state.sources && typeof state.sources === 'object' ? state.sources : {},
    global_blocked_attempts: Array.isArray(state && state.global_blocked_attempts)
      ? state.global_blocked_attempts
      : []
  };
  writeJson(policy.state_path, out);
  return out;
}

function evaluateTestOpacityGate(prompt, source, phase) {
  const policy = loadTestOpacityPolicy();
  const sourceName = String(source || 'llm_gateway').trim() || 'llm_gateway';
  if (policy.enabled !== true) {
    return { allowed: true, reason: 'policy_disabled', policy_version: policy.version, source: sourceName };
  }
  const nowMs = Date.now();
  const ts = nowIso();
  const windowMs = Math.max(10000, Number(policy.anti_reverse_engineering.window_seconds || 900) * 1000);
  const cutoffMs = nowMs - windowMs;
  const normPrompt = normalizePromptForSecurity(prompt);
  const pathHits = regexHitStrings(normPrompt, policy._blocked_path_regex);
  const intentHits = regexHitStrings(normPrompt, policy._blocked_intent_regex);
  const suspiciousHits = (policy.anti_reverse_engineering.suspicious_terms || [])
    .filter((term) => term && normPrompt.includes(term))
    .slice(0, 24);
  const blockedByPrompt = pathHits.length > 0 || intentHits.length > 0;
  const signature = hashPromptSignature(normPrompt);

  const state = loadOpacityState(policy);
  if (!state.sources[sourceName] || typeof state.sources[sourceName] !== 'object') {
    state.sources[sourceName] = {
      blocked_attempts: [],
      locked_until: null
    };
  }
  const sourceState = state.sources[sourceName];
  sourceState.blocked_attempts = pruneTimedRows(sourceState.blocked_attempts, cutoffMs);
  state.global_blocked_attempts = pruneTimedRows(state.global_blocked_attempts, cutoffMs);

  const lockUntilMs = Date.parse(String(sourceState.locked_until || ''));
  const lockActive = Number.isFinite(lockUntilMs) && lockUntilMs > nowMs;
  if (lockActive) {
    const incident = {
      ts,
      type: 'llm_test_opacity_lockout_block',
      source: sourceName,
      phase: String(phase || 'general'),
      reason: 'source_lockout_active',
      lockout_until: String(sourceState.locked_until || '')
    };
    appendJsonlAlways(policy.incident_log_path, incident);
    saveOpacityState(policy, state);
    return {
      allowed: false,
      reason: 'source_lockout_active',
      policy_version: policy.version,
      source: sourceName,
      lockout_until: String(sourceState.locked_until || ''),
      blocked_path_hits: [],
      blocked_intent_hits: [],
      suspicious_hits: []
    };
  }

  if (!blockedByPrompt) {
    saveOpacityState(policy, state);
    return {
      allowed: true,
      reason: 'pass',
      policy_version: policy.version,
      source: sourceName
    };
  }

  const blockedAttempt = {
    ts,
    phase: String(phase || 'general'),
    signature,
    blocked_path_hits: pathHits.slice(0, 12),
    blocked_intent_hits: intentHits.slice(0, 12),
    suspicious_hits: suspiciousHits.slice(0, 12)
  };
  sourceState.blocked_attempts.push(blockedAttempt);
  sourceState.blocked_attempts = pruneTimedRows(sourceState.blocked_attempts, cutoffMs);
  state.global_blocked_attempts.push({
    ts,
    source: sourceName,
    signature
  });
  state.global_blocked_attempts = pruneTimedRows(state.global_blocked_attempts, cutoffMs);

  const sourceAttempts = sourceState.blocked_attempts.length;
  const uniqueSignatures = new Set(sourceState.blocked_attempts.map((row) => String(row.signature || ''))).size;
  const globalAttempts = state.global_blocked_attempts.length;

  let lockoutTriggered = false;
  if (policy.anti_reverse_engineering.enabled === true) {
    if (
      sourceAttempts >= Number(policy.anti_reverse_engineering.max_blocked_attempts_per_window || 4)
      || uniqueSignatures >= Number(policy.anti_reverse_engineering.max_unique_signatures_per_window || 3)
      || globalAttempts >= Number(policy.anti_reverse_engineering.max_global_blocked_attempts_per_window || 20)
    ) {
      lockoutTriggered = true;
      const lockoutMs = Math.max(10000, Number(policy.anti_reverse_engineering.lockout_seconds || 1800) * 1000);
      sourceState.locked_until = new Date(nowMs + lockoutMs).toISOString();
    }
  }

  state.sources[sourceName] = sourceState;
  saveOpacityState(policy, state);
  appendJsonlAlways(policy.incident_log_path, {
    ts,
    type: lockoutTriggered ? 'llm_test_opacity_lockout_triggered' : 'llm_test_opacity_blocked',
    source: sourceName,
    phase: String(phase || 'general'),
    signature,
    blocked_path_hits: pathHits.slice(0, 12),
    blocked_intent_hits: intentHits.slice(0, 12),
    suspicious_hits: suspiciousHits.slice(0, 12),
    source_attempts_in_window: sourceAttempts,
    unique_signatures_in_window: uniqueSignatures,
    global_attempts_in_window: globalAttempts,
    lockout_until: lockoutTriggered ? String(sourceState.locked_until || '') : null
  });
  return {
    allowed: false,
    reason: lockoutTriggered ? 'bruteforce_lockout' : 'opaque_test_surface_blocked',
    policy_version: policy.version,
    source: sourceName,
    lockout_until: lockoutTriggered ? String(sourceState.locked_until || '') : null,
    blocked_path_hits: pathHits.slice(0, 12),
    blocked_intent_hits: intentHits.slice(0, 12),
    suspicious_hits: suspiciousHits.slice(0, 12)
  };
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

function pullLocalOllamaModel(opts = {}) {
  const o = (opts && typeof opts === 'object' ? opts : {}) as Record<string, any>;
  const model = normalizeModelName(o.model);
  const timeoutMs = Number.isFinite(Number(o.timeoutMs)) ? Number(o.timeoutMs) : 60000;
  const source = String(o.source || 'llm_gateway').trim() || 'llm_gateway';
  const cwd = o.cwd ? String(o.cwd) : REPO_ROOT;
  if (!model) {
    return {
      ok: false,
      model: '',
      latency_ms: 0,
      code: 2,
      stderr: 'model_required',
      stdout: '',
      error: null
    };
  }

  const started = Date.now();
  const r = spawnSync('ollama', ['pull', model], {
    encoding: 'utf8',
    timeout: timeoutMs,
    cwd
  });
  const latencyMs = Date.now() - started;
  const errTxt = r.error ? String(r.error && r.error.message ? r.error.message : r.error) : '';
  const stdout = stripAnsi(r.stdout || '');
  const stderr = stripAnsi(r.stderr || '');
  const ok = r.status === 0 && !r.error;

  appendJsonl(GATEWAY_LOG_PATH, {
    ts: nowIso(),
    type: 'llm_gateway_pull',
    ok,
    source,
    model,
    timeout_ms: timeoutMs,
    latency_ms: latencyMs,
    code: r.status == null ? 1 : r.status,
    error: errTxt || null,
    stderr: stderr.slice(-240)
  });

  return {
    ok,
    model,
    latency_ms: latencyMs,
    code: r.status == null ? 1 : r.status,
    stderr,
    stdout,
    error: errTxt || null
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

  const opacityGate = evaluateTestOpacityGate(prompt, source, phase);
  if (opacityGate.allowed !== true) {
    const lockoutReason = opacityGate.reason === 'source_lockout_active' || opacityGate.reason === 'bruteforce_lockout';
    const errorCode = lockoutReason ? 'test_opacity_source_lockout' : 'test_opacity_blocked';
    appendJsonl(GATEWAY_LOG_PATH, {
      ts: nowIso(),
      type: 'llm_gateway_opacity_block',
      ok: false,
      source,
      phase,
      model,
      reason: opacityGate.reason,
      policy_version: opacityGate.policy_version || null,
      lockout_until: opacityGate.lockout_until || null,
      blocked_path_hits: opacityGate.blocked_path_hits || [],
      blocked_intent_hits: opacityGate.blocked_intent_hits || [],
      suspicious_hits: opacityGate.suspicious_hits || []
    });
    return {
      ok: false,
      stdout: '',
      stderr: 'test_opacity_blocked',
      code: 451,
      signal: null,
      timed_out: false,
      error: errorCode,
      latency_ms: 0,
      model,
      phase,
      blocked: true,
      block_reason: opacityGate.reason,
      lockout_until: opacityGate.lockout_until || null
    };
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
  pullLocalOllamaModel,
  runLocalOllamaPrompt,
  evaluateTestOpacityGate,
  stripAnsi,
  isUnknownFlagError,
  normalizeModelName
};
export {};
