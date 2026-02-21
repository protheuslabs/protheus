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
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const GATEWAY_LOG_PATH = process.env.LLM_GATEWAY_LOG_PATH
  ? path.resolve(String(process.env.LLM_GATEWAY_LOG_PATH))
  : path.join(REPO_ROOT, 'state', 'routing', 'llm_gateway_calls.jsonl');
const GATEWAY_LOG_ENABLED = String(process.env.LLM_GATEWAY_LOG_ENABLED || '1').trim() !== '0';

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

function isUnknownFlagError(text) {
  return /\b(unknown flag|unknown shorthand|unknown option|unknown command|flag provided but not defined|invalid option)\b/i
    .test(String(text || ''));
}

function listLocalOllamaModels(opts = {}) {
  const timeoutMs = Number.isFinite(Number(opts.timeoutMs)) ? Number(opts.timeoutMs) : 5000;
  const cwd = opts.cwd ? String(opts.cwd) : REPO_ROOT;
  const source = String(opts.source || 'llm_gateway').trim() || 'llm_gateway';
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
  const model = normalizeModelName(opts.model);
  const prompt = String(opts.prompt || '');
  const timeoutMs = Number.isFinite(Number(opts.timeoutMs)) ? Number(opts.timeoutMs) : 25000;
  const phase = String(opts.phase || 'general').trim() || 'general';
  const source = String(opts.source || 'llm_gateway').trim() || 'llm_gateway';
  const cwd = opts.cwd ? String(opts.cwd) : REPO_ROOT;
  const allowFlagFallback = opts.allowFlagFallback !== false;

  if (!model) {
    return { ok: false, stdout: '', stderr: 'no_local_model_selected', code: 2, signal: null, timed_out: false, error: null, latency_ms: 0 };
  }

  const primary = runOllamaPromptRaw(model, prompt, timeoutMs, ['--hidethinking', '--nowordwrap'], cwd);
  let final = primary;
  let fallbackAttempted = false;
  if (!primary.ok && allowFlagFallback && (isUnknownFlagError(primary.stderr) || isUnknownFlagError(primary.error))) {
    fallbackAttempted = true;
    const fallback = runOllamaPromptRaw(model, prompt, timeoutMs, [], cwd);
    final = fallback.ok ? fallback : { ...fallback, flag_fallback_attempted: true };
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
    stderr_tail: String(final.stderr || '').slice(-180)
  });

  return {
    ...final,
    model,
    phase,
    fallback_attempted: fallbackAttempted
  };
}

module.exports = {
  listLocalOllamaModels,
  runLocalOllamaPrompt,
  stripAnsi,
  isUnknownFlagError,
  normalizeModelName
};

