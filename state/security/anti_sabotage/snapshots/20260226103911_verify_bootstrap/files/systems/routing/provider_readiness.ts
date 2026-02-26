#!/usr/bin/env node
'use strict';

/**
 * systems/routing/provider_readiness.js
 *
 * Shared local-provider readiness gate + circuit breaker.
 * Current provider support:
 * - ollama (local runtime)
 *
 * Goals:
 * - Fast short-circuit when provider is down.
 * - Cached readiness checks to avoid repeated expensive probes.
 * - Circuit-open backoff to prevent retry storms.
 * - Single outage pain signal per cooldown window (no per-call spam).
 */

const fs = require('fs');
const path = require('path');
const { emitPainSignal } = require('../autonomy/pain_signal');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const STATE_PATH = process.env.PROVIDER_READINESS_STATE_PATH
  ? path.resolve(String(process.env.PROVIDER_READINESS_STATE_PATH))
  : path.join(REPO_ROOT, 'state', 'routing', 'provider_readiness.json');
const EVENTS_PATH = process.env.PROVIDER_READINESS_EVENTS_PATH
  ? path.resolve(String(process.env.PROVIDER_READINESS_EVENTS_PATH))
  : path.join(REPO_ROOT, 'state', 'routing', 'provider_readiness_events.jsonl');
const PAIN_EMIT_STATE_PATH = process.env.PROVIDER_READINESS_PAIN_STATE_PATH
  ? path.resolve(String(process.env.PROVIDER_READINESS_PAIN_STATE_PATH))
  : path.join(REPO_ROOT, 'state', 'routing', 'provider_readiness_pain.json');
const PAIN_EMIT_LOCK_PATH = process.env.PROVIDER_READINESS_PAIN_LOCK_PATH
  ? path.resolve(String(process.env.PROVIDER_READINESS_PAIN_LOCK_PATH))
  : path.join(REPO_ROOT, 'state', 'routing', 'provider_readiness_pain.lock');

const CHECK_TTL_MS_DEFAULT = clampInt(process.env.PROVIDER_READINESS_CHECK_TTL_MS || 30 * 1000, 1000, 10 * 60 * 1000);
const TIMEOUT_MS_DEFAULT = clampInt(process.env.PROVIDER_READINESS_TIMEOUT_MS || 5000, 1000, 120000);
const FAILURES_TO_OPEN_DEFAULT = clampInt(process.env.PROVIDER_READINESS_FAILURES_TO_OPEN || 1, 1, 12);
const CIRCUIT_OPEN_BASE_MS_DEFAULT = clampInt(process.env.PROVIDER_READINESS_CIRCUIT_BASE_MS || 2 * 60 * 1000, 1000, 12 * 60 * 60 * 1000);
const CIRCUIT_OPEN_MAX_MS_DEFAULT = clampInt(process.env.PROVIDER_READINESS_CIRCUIT_MAX_MS || 45 * 60 * 1000, CIRCUIT_OPEN_BASE_MS_DEFAULT, 24 * 60 * 60 * 1000);
const ENV_BLOCKED_FAILURES_TO_OPEN_DEFAULT = clampInt(process.env.PROVIDER_READINESS_ENV_BLOCKED_FAILURES_TO_OPEN || 1, 1, 3);
const ENV_BLOCKED_CIRCUIT_MS_DEFAULT = clampInt(process.env.PROVIDER_READINESS_ENV_BLOCKED_CIRCUIT_MS || 45 * 1000, 5000, 10 * 60 * 1000);
const PAIN_ENABLED_DEFAULT = String(process.env.PROVIDER_READINESS_EMIT_PAIN || '1').trim() !== '0';
const PAIN_COOLDOWN_MS_DEFAULT = clampInt(process.env.PROVIDER_READINESS_PAIN_COOLDOWN_MS || 6 * 60 * 60 * 1000, 60 * 1000, 14 * 24 * 60 * 60 * 1000);

function nowIso() {
  return new Date().toISOString();
}

function clampInt(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function toBool(v, fallback = false) {
  if (v == null) return fallback;
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  return fallback;
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

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function appendJsonl(filePath, row) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, JSON.stringify(row) + '\n', 'utf8');
}

function parseIsoMs(v) {
  const ms = Date.parse(String(v || ''));
  return Number.isFinite(ms) ? ms : null;
}

function normalizeProvider(v) {
  const raw = String(v || '').trim().toLowerCase();
  if (!raw) return '';
  if (raw === 'ollama' || raw === 'ollama_local') return 'ollama';
  return raw;
}

function providerEnvToken(provider) {
  return String(provider || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function forcedProviderStatus(provider) {
  const scopedKey = `PROVIDER_READINESS_FORCE_STATUS_${providerEnvToken(provider)}`;
  const raw = String(process.env[scopedKey] || process.env.PROVIDER_READINESS_FORCE_STATUS || '').trim().toLowerCase();
  if (!raw) return null;
  if (['up', 'ok', 'ready', 'healthy', '1', 'true'].includes(raw)) return 'up';
  if (['down', 'fail', 'unavailable', '0', 'false'].includes(raw)) return 'down';
  return null;
}

function forcedProviderReason(provider, status) {
  const scopedKey = `PROVIDER_READINESS_FORCE_REASON_${providerEnvToken(provider)}`;
  const raw = String(process.env[scopedKey] || process.env.PROVIDER_READINESS_FORCE_REASON || '').trim();
  if (raw) return raw.slice(0, 120);
  return status === 'up' ? 'forced_up' : 'forced_down';
}

function localProviderForModel(modelId) {
  const raw = String(modelId || '').trim().toLowerCase();
  if (!raw) return null;
  if (!raw.startsWith('ollama/')) return null;
  if (raw.includes(':cloud')) return null;
  return 'ollama';
}

function defaultProviderRow(provider) {
  return {
    provider,
    status: 'unknown',
    last_check_ts: null,
    last_success_ts: null,
    last_failure_ts: null,
    last_latency_ms: null,
    last_error: null,
    last_code: null,
    failure_streak: 0,
    success_streak: 0,
    circuit_open_until_ts: null,
    circuit_reason: null,
    last_pain_ts: null
  };
}

function loadState() {
  const raw = readJsonSafe(STATE_PATH, null);
  if (!raw || typeof raw !== 'object') {
    return {
      version: '1.0',
      updated_ts: null,
      providers: {}
    };
  }
  const providers = raw.providers && typeof raw.providers === 'object' ? raw.providers : {};
  return {
    version: '1.0',
    updated_ts: String(raw.updated_ts || '') || null,
    providers
  };
}

function saveState(state) {
  writeJson(STATE_PATH, {
    version: '1.0',
    updated_ts: nowIso(),
    providers: state && state.providers && typeof state.providers === 'object'
      ? state.providers
      : {}
  });
}

function loadPainEmitState() {
  const raw = readJsonSafe(PAIN_EMIT_STATE_PATH, null);
  if (!raw || typeof raw !== 'object') {
    return {
      version: '1.0',
      updated_ts: null,
      providers: {}
    };
  }
  return {
    version: '1.0',
    updated_ts: String(raw.updated_ts || '') || null,
    providers: raw.providers && typeof raw.providers === 'object' ? raw.providers : {}
  };
}

function savePainEmitState(state) {
  writeJson(PAIN_EMIT_STATE_PATH, {
    version: '1.0',
    updated_ts: nowIso(),
    providers: state && state.providers && typeof state.providers === 'object'
      ? state.providers
      : {}
  });
}

function withPainEmitLock(fn) {
  ensureDir(path.dirname(PAIN_EMIT_LOCK_PATH));
  let fd = null;
  try {
    fd = fs.openSync(PAIN_EMIT_LOCK_PATH, 'wx');
  } catch (err) {
    if (err && err.code === 'EEXIST') return { locked: false, reason: 'lock_exists', value: null };
    return { locked: false, reason: 'lock_failed', value: null };
  }
  try {
    return { locked: true, reason: null, value: fn() };
  } finally {
    try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(PAIN_EMIT_LOCK_PATH); } catch {}
  }
}

function classifyOllamaFailure(stderr, code) {
  const blob = `${String(stderr || '')} ${String(code == null ? '' : code)}`.toLowerCase();
  if (/\b(operation not permitted|permission denied|sandbox)\b/.test(blob)) return 'env_blocked';
  if (/\b(etimedout|timed out|timeout)\b/.test(blob)) return 'provider_timeout';
  if (/\b(connection refused|failed to connect|dial tcp|127\.0\.0\.1:11434|econnrefused|ehostunreach|enotfound|network is unreachable)\b/.test(blob)) {
    return 'provider_unreachable';
  }
  return 'provider_unavailable';
}

function normalizeModelName(v) {
  const raw = String(v || '').trim().replace(/^ollama\//, '').toLowerCase();
  if (!raw) return '';
  if (raw.endsWith(':latest')) return raw.slice(0, -(':latest'.length));
  return raw;
}

function stripAnsi(v) {
  return String(v || '')
    .replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/[\u2800-\u28ff]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function probeProvider(provider, opts = {}) {
  const source = String(opts.source || 'provider_readiness').trim() || 'provider_readiness';
  const timeoutMs = clampInt(opts.timeout_ms || TIMEOUT_MS_DEFAULT, 1000, 120000);
  if (provider === 'ollama') {
    const startedMs = Date.now();
    try {
      const { listLocalOllamaModels } = require('./llm_gateway');
      const listed = typeof listLocalOllamaModels === 'function'
        ? listLocalOllamaModels({
            timeoutMs,
            source: `${source}_provider_probe`,
            skip_provider_gate: true
          })
        : null;
      const latencyMs = Number.isFinite(Number(listed && listed.latency_ms))
        ? Number(listed.latency_ms)
        : (Date.now() - startedMs);
      if (listed && listed.ok === true) {
        const models = Array.isArray(listed.models) ? listed.models.map(normalizeModelName).filter(Boolean) : [];
        return {
          ok: true,
          provider,
          status: 'up',
          reason: 'ok',
          latency_ms: latencyMs,
          code: 0,
          stderr: null,
          model_count: Array.from(new Set(models)).length
        };
      }
      const stderr = stripAnsi(listed && listed.stderr || '');
      return {
        ok: false,
        provider,
        status: 'down',
        reason: classifyOllamaFailure(stderr, listed && listed.code),
        latency_ms: latencyMs,
        code: Number(listed && listed.code == null ? 1 : listed.code),
        stderr: String(stderr || '').slice(0, 240),
        model_count: 0
      };
    } catch (err) {
      const latencyMs = Date.now() - startedMs;
      const stderr = stripAnsi(err && err.message ? err.message : String(err || 'provider_probe_failed'));
      return {
        ok: false,
        provider,
        status: 'down',
        reason: classifyOllamaFailure(stderr, 1),
        latency_ms: latencyMs,
        code: 1,
        stderr: String(stderr || '').slice(0, 240),
        model_count: 0
      };
    }
  }
  return {
    ok: false,
    provider,
    status: 'down',
    reason: 'unsupported_provider',
    latency_ms: 0,
    code: 1,
    stderr: 'unsupported_provider',
    model_count: 0
  };
}

function compactGateResult(base, row, extra = {}) {
  return {
    applicable: true,
    provider: base.provider,
    available: base.available === true,
    reason: String(base.reason || ''),
    source: String(base.source || ''),
    checked: base.checked === true,
    status: row && row.status ? String(row.status) : 'unknown',
    circuit_open: !!(row && parseIsoMs(row.circuit_open_until_ts) && parseIsoMs(row.circuit_open_until_ts) > Date.now()),
    circuit_open_until_ts: row && row.circuit_open_until_ts ? String(row.circuit_open_until_ts) : null,
    last_check_ts: row && row.last_check_ts ? String(row.last_check_ts) : null,
    last_success_ts: row && row.last_success_ts ? String(row.last_success_ts) : null,
    last_failure_ts: row && row.last_failure_ts ? String(row.last_failure_ts) : null,
    failure_streak: Number(row && row.failure_streak || 0),
    success_streak: Number(row && row.success_streak || 0),
    last_latency_ms: Number.isFinite(Number(row && row.last_latency_ms)) ? Number(row.last_latency_ms) : null,
    last_code: Number.isFinite(Number(row && row.last_code)) ? Number(row.last_code) : null,
    ...extra
  };
}

function maybeEmitOutagePain(provider, row, probe, opts = {}) {
  const emitPain = toBool(opts.emit_pain, PAIN_ENABLED_DEFAULT);
  if (!emitPain) return { emitted: false, reason: 'pain_disabled' };
  const painCooldownMs = clampInt(opts.pain_cooldown_ms || PAIN_COOLDOWN_MS_DEFAULT, 60 * 1000, 14 * 24 * 60 * 60 * 1000);
  const lockResult = withPainEmitLock(() => {
    const nowMs = Date.now();
    const painState = loadPainEmitState();
    if (!painState.providers || typeof painState.providers !== 'object') painState.providers = {};
    const stampTs = String(painState.providers[provider] || '').trim();
    const stampMs = parseIsoMs(stampTs);
    const lastPainMs = parseIsoMs(row && row.last_pain_ts);
    const mostRecentMs = Number.isFinite(stampMs) && Number.isFinite(lastPainMs)
      ? Math.max(stampMs, lastPainMs)
      : (Number.isFinite(stampMs) ? stampMs : lastPainMs);
    if (Number.isFinite(mostRecentMs) && (nowMs - mostRecentMs) < painCooldownMs) {
      return { emitted: false, reason: 'pain_cooldown_active', escalation: null };
    }
    let out = null;
    try {
      out = emitPainSignal({
        ts: nowIso(),
        source: 'provider_readiness',
        subsystem: 'routing',
        code: `provider_outage:${provider}:${String(probe && probe.reason || 'unavailable')}`,
        summary: `Provider ${provider} unavailable`,
        details: `reason=${String(probe && probe.reason || 'unknown')} code=${Number(probe && probe.code != null ? probe.code : 1)} latency_ms=${Number(probe && probe.latency_ms || 0)}`,
        severity: String(probe && probe.reason || '').includes('env_blocked') ? 'low' : 'medium',
        risk: 'low',
        create_proposal: false,
        window_hours: 12,
        escalate_after: 99,
        cooldown_hours: Math.max(1, Math.round(painCooldownMs / (60 * 60 * 1000))),
        signature_extra: `${provider}|${String(probe && probe.reason || 'unavailable')}`
      });
    } catch {
      return { emitted: false, reason: 'pain_emit_failed', escalation: null };
    }
    const ts = nowIso();
    painState.providers[provider] = ts;
    savePainEmitState(painState);
    row.last_pain_ts = ts;
    appendJsonl(EVENTS_PATH, {
      ts,
      type: 'provider_outage_pain',
      provider,
      reason: String(probe && probe.reason || 'unknown'),
      code: Number(probe && probe.code != null ? probe.code : 1),
      emitted: true
    });
    return {
      emitted: true,
      reason: 'pain_emitted',
      escalation: out && out.escalation ? out.escalation : null
    };
  });

  if (lockResult.locked !== true) return { emitted: false, reason: lockResult.reason || 'pain_emit_locked' };
  return lockResult.value && typeof lockResult.value === 'object'
    ? lockResult.value
    : { emitted: false, reason: 'pain_emit_unknown' };
}

function evaluateProviderGate(providerInput, opts = {}) {
  const provider = normalizeProvider(providerInput);
  if (!provider) {
    return {
      applicable: false,
      provider: null,
      available: true,
      reason: 'not_local_provider',
      source: 'n/a',
      checked: false
    };
  }

  const source = String(opts.source || 'provider_readiness').trim() || 'provider_readiness';
  const forceCheck = opts.force_check === true || opts.forceCheck === true || String(opts.force_check || opts.forceCheck || '') === '1';
  const checkTtlMs = clampInt(opts.check_ttl_ms || CHECK_TTL_MS_DEFAULT, 1000, 10 * 60 * 1000);
  const failuresToOpen = clampInt(opts.failures_to_open || FAILURES_TO_OPEN_DEFAULT, 1, 12);
  const circuitBaseMs = clampInt(opts.circuit_open_base_ms || CIRCUIT_OPEN_BASE_MS_DEFAULT, 1000, 12 * 60 * 60 * 1000);
  const circuitMaxMs = clampInt(opts.circuit_open_max_ms || CIRCUIT_OPEN_MAX_MS_DEFAULT, circuitBaseMs, 24 * 60 * 60 * 1000);
  const envBlockedFailuresToOpen = clampInt(
    opts.env_blocked_failures_to_open || ENV_BLOCKED_FAILURES_TO_OPEN_DEFAULT,
    1,
    3
  );
  const envBlockedCircuitMs = clampInt(
    opts.env_blocked_circuit_ms || ENV_BLOCKED_CIRCUIT_MS_DEFAULT,
    5000,
    circuitMaxMs
  );

  const state = loadState();
  if (!state.providers || typeof state.providers !== 'object') state.providers = {};
  const prev = state.providers[provider] && typeof state.providers[provider] === 'object'
    ? state.providers[provider]
    : defaultProviderRow(provider);
  const row = { ...defaultProviderRow(provider), ...prev, provider };
  const nowMs = Date.now();
  const forcedStatus = forcedProviderStatus(provider);
  if (forcedStatus) {
    const reason = forcedProviderReason(provider, forcedStatus);
    row.last_check_ts = nowIso();
    row.last_latency_ms = 0;
    row.last_code = forcedStatus === 'up' ? 0 : 1;
    if (forcedStatus === 'up') {
      row.status = 'up';
      row.last_success_ts = nowIso();
      row.last_error = null;
      row.failure_streak = 0;
      row.success_streak = clampInt(Number(row.success_streak || 0) + 1, 1, 10000);
      row.circuit_open_until_ts = null;
      row.circuit_reason = null;
    } else {
      row.status = 'down';
      row.last_failure_ts = nowIso();
      row.last_error = reason;
      row.success_streak = 0;
      row.failure_streak = clampInt(Number(row.failure_streak || 0) + 1, 1, 10000);
      const openMs = Math.min(CIRCUIT_OPEN_MAX_MS_DEFAULT, CIRCUIT_OPEN_BASE_MS_DEFAULT);
      row.circuit_open_until_ts = new Date(nowMs + openMs).toISOString();
      row.circuit_reason = reason;
    }
    state.providers[provider] = row;
    saveState(state);
    appendJsonl(EVENTS_PATH, {
      ts: nowIso(),
      type: 'provider_forced_status',
      provider,
      source,
      forced_status: forcedStatus,
      reason
    });
    return compactGateResult({
      provider,
      available: forcedStatus === 'up',
      reason,
      source: 'forced',
      checked: true
    }, row);
  }

  const circuitUntilMs = parseIsoMs(row.circuit_open_until_ts);
  if (!forceCheck && Number.isFinite(circuitUntilMs) && circuitUntilMs > nowMs) {
    return compactGateResult({
      provider,
      available: false,
      reason: row.circuit_reason || 'circuit_open',
      source: 'circuit_open',
      checked: false
    }, row);
  }

  const lastCheckMs = parseIsoMs(row.last_check_ts);
  const ageMs = Number.isFinite(lastCheckMs) ? Math.max(0, nowMs - lastCheckMs) : null;
  if (!forceCheck && Number.isFinite(ageMs) && ageMs <= checkTtlMs && (row.status === 'up' || row.status === 'down')) {
    return compactGateResult({
      provider,
      available: row.status === 'up',
      reason: row.status === 'up' ? 'ok_cached' : (row.circuit_reason || row.last_error || 'provider_down_cached'),
      source: 'cache',
      checked: false
    }, row, { cache_age_ms: ageMs });
  }

  const probe = probeProvider(provider, { source, timeout_ms: opts.timeout_ms });
  row.last_check_ts = nowIso();
  row.last_latency_ms = Number.isFinite(Number(probe.latency_ms)) ? Number(probe.latency_ms) : null;
  row.last_code = Number.isFinite(Number(probe.code)) ? Number(probe.code) : null;

  if (probe.ok === true) {
    const recovered = row.status === 'down';
    row.status = 'up';
    row.last_success_ts = nowIso();
    row.last_error = null;
    row.failure_streak = 0;
    row.success_streak = clampInt(Number(row.success_streak || 0) + 1, 1, 10000);
    row.circuit_open_until_ts = null;
    row.circuit_reason = null;
    state.providers[provider] = row;
    saveState(state);
    appendJsonl(EVENTS_PATH, {
      ts: nowIso(),
      type: recovered ? 'provider_recovered' : 'provider_ok',
      provider,
      source,
      latency_ms: row.last_latency_ms,
      model_count: Number(probe.model_count || 0)
    });
    return compactGateResult({
      provider,
      available: true,
      reason: recovered ? 'provider_recovered' : 'ok',
      source: 'probe',
      checked: true
    }, row, { model_count: Number(probe.model_count || 0) });
  }

  row.status = 'down';
  row.last_failure_ts = nowIso();
  row.last_error = String(probe.reason || 'provider_unavailable');
  row.success_streak = 0;
  row.failure_streak = clampInt(Number(row.failure_streak || 0) + 1, 1, 10000);
  const envBlocked = String(probe.reason || '') === 'env_blocked';
  const openThreshold = envBlocked ? envBlockedFailuresToOpen : failuresToOpen;
  const shouldOpen = row.failure_streak >= openThreshold;
  if (shouldOpen) {
    const exp = Math.max(0, row.failure_streak - openThreshold);
    let openMs = Math.min(circuitMaxMs, circuitBaseMs * Math.pow(2, exp));
    if (envBlocked) openMs = Math.min(openMs, envBlockedCircuitMs);
    row.circuit_open_until_ts = new Date(nowMs + openMs).toISOString();
    row.circuit_reason = String(probe.reason || 'provider_unavailable');
  } else {
    row.circuit_open_until_ts = null;
    row.circuit_reason = String(probe.reason || 'provider_unavailable');
  }

  const pain = maybeEmitOutagePain(provider, row, probe, opts);
  state.providers[provider] = row;
  saveState(state);
  appendJsonl(EVENTS_PATH, {
    ts: nowIso(),
    type: 'provider_down',
    provider,
    source,
    reason: row.circuit_reason,
    code: row.last_code,
    failure_streak: row.failure_streak,
    circuit_open_until_ts: row.circuit_open_until_ts,
    pain_emitted: pain.emitted === true
  });

  return compactGateResult({
    provider,
    available: false,
    reason: row.circuit_reason || 'provider_unavailable',
    source: 'probe',
    checked: true
  }, row, {
    pain_emitted: pain.emitted === true
  });
}

function evaluateLocalProviderGate(modelId, opts = {}) {
  const provider = localProviderForModel(modelId);
  if (!provider) {
    return {
      applicable: false,
      provider: null,
      available: true,
      reason: 'not_local_provider',
      source: 'n/a',
      checked: false
    };
  }
  return evaluateProviderGate(provider, opts);
}

function status(providerInput) {
  const provider = normalizeProvider(providerInput || 'ollama');
  const state = loadState();
  const row = state.providers && state.providers[provider] && typeof state.providers[provider] === 'object'
    ? state.providers[provider]
    : defaultProviderRow(provider);
  return compactGateResult({
    provider,
    available: row.status === 'up',
    reason: row.status === 'up' ? 'ok' : (row.circuit_reason || row.last_error || 'unknown'),
    source: 'state',
    checked: false
  }, row);
}

function parseArgs(argv) {
  const out = { _: [] };
  for (const arg of argv) {
    const raw = String(arg || '');
    if (!raw.startsWith('--')) {
      out._.push(raw);
      continue;
    }
    const eq = raw.indexOf('=');
    if (eq < 0) out[raw.slice(2)] = true;
    else out[raw.slice(2, eq)] = raw.slice(eq + 1);
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim().toLowerCase();
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    process.stdout.write(
      'Usage:\n' +
      '  node systems/routing/provider_readiness.js status [--provider=ollama]\n' +
      '  node systems/routing/provider_readiness.js check [--provider=ollama] [--force=1]\n'
    );
    return;
  }
  const provider = String(args.provider || 'ollama').trim();
  if (cmd === 'status') {
    process.stdout.write(JSON.stringify({ ok: true, ...status(provider) }) + '\n');
    return;
  }
  if (cmd === 'check') {
    const out = evaluateProviderGate(provider, {
      source: 'provider_readiness_cli',
      force_check: String(args.force || '0') === '1'
    });
    process.stdout.write(JSON.stringify({ ok: true, ...out }) + '\n');
    return;
  }
  process.stdout.write(JSON.stringify({ ok: false, error: 'unknown_command', cmd }) + '\n');
  process.exit(2);
}

if (require.main === module) main();

module.exports = {
  localProviderForModel,
  evaluateProviderGate,
  evaluateLocalProviderGate,
  status
};
