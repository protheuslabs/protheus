#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-110
 * Canonical transport abstraction for rust memory daemon/cli/fallback semantics.
 */

type AnyObj = Record<string, any>;

function cleanText(v: unknown, maxLen = 240) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function toErrorCode(value: unknown, fallback = 'transport_failed') {
  const s = cleanText(value || '', 160);
  if (!s) return fallback;
  return s.toLowerCase().replace(/[^a-z0-9_.:-]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
}

function summarizeAttempts(rows: AnyObj[]) {
  const attempts = Array.isArray(rows) ? rows : [];
  return attempts.map((row) => ({
    mode: cleanText(row.mode || 'unknown', 40) || 'unknown',
    ok: row.ok === true,
    error: row.error ? toErrorCode(row.error, 'transport_failed') : null
  }));
}

async function runUnifiedMemoryTransport(opts: AnyObj) {
  const attempts: AnyObj[] = [];
  const allowCliFallback = opts.allow_cli_fallback !== false;
  const inProcessEnabled = opts.in_process_enabled === true && typeof opts.invoke_in_process === 'function';
  const inProcessMode = cleanText(opts.in_process_mode || 'napi', 40) || 'napi';
  const daemonEnabled = opts.daemon_enabled !== false && typeof opts.invoke_daemon === 'function';

  let inProcessError = null;
  if (inProcessEnabled) {
    let inProcessResult: AnyObj = {};
    try {
      inProcessResult = await opts.invoke_in_process();
    } catch (err) {
      inProcessResult = {
        ok: false,
        error: `in_process_throw_${cleanText(err && (err.code || err.message) ? (err.code || err.message) : 'unknown', 80)}`
      };
    }
    attempts.push({
      mode: inProcessMode,
      ok: inProcessResult && inProcessResult.ok === true,
      error: inProcessResult && inProcessResult.ok !== true ? inProcessResult.error || 'in_process_failed' : null
    });
    if (inProcessResult && inProcessResult.ok === true && inProcessResult.payload && inProcessResult.payload.ok === true) {
      return {
        ok: true,
        payload: inProcessResult.payload,
        transport: inProcessMode,
        transport_detail: cleanText(inProcessResult.transport_detail || inProcessResult.module_path || 'in_process', 140),
        fallback_reason: null,
        attempts: summarizeAttempts(attempts)
      };
    }
    inProcessError = inProcessResult && inProcessResult.error
      ? toErrorCode(inProcessResult.error, 'in_process_failed')
      : 'in_process_failed';
  }

  let daemonError = null;
  if (daemonEnabled) {
    let daemonResult: AnyObj = {};
    try {
      daemonResult = await opts.invoke_daemon();
    } catch (err) {
      daemonResult = {
        ok: false,
        error: `daemon_throw_${cleanText(err && (err.code || err.message) ? (err.code || err.message) : 'unknown', 80)}`
      };
    }
    attempts.push({
      mode: 'daemon',
      ok: daemonResult && daemonResult.ok === true,
      error: daemonResult && daemonResult.ok !== true ? daemonResult.error || 'daemon_failed' : null
    });
    if (daemonResult && daemonResult.ok === true && daemonResult.payload && daemonResult.payload.ok === true) {
      return {
        ok: true,
        payload: daemonResult.payload,
        transport: 'daemon',
        transport_detail: cleanText(opts.daemon_detail || 'tcp', 80) || 'tcp',
        fallback_reason: inProcessError,
        attempts: summarizeAttempts(attempts)
      };
    }
    daemonError = daemonResult && daemonResult.error ? toErrorCode(daemonResult.error, 'daemon_failed') : 'daemon_failed';
  }

  if (!allowCliFallback) {
    return {
      ok: false,
      error: daemonError || inProcessError || 'cli_fallback_disabled',
      transport: 'none',
      transport_detail: null,
      fallback_reason: daemonError || inProcessError || null,
      attempts: summarizeAttempts(attempts)
    };
  }

  if (typeof opts.invoke_cli !== 'function') {
    return {
      ok: false,
      error: daemonError || inProcessError || 'cli_unavailable',
      transport: 'none',
      transport_detail: null,
      fallback_reason: daemonError || inProcessError || null,
      attempts: summarizeAttempts(attempts)
    };
  }

  let cliResult: AnyObj = {};
  try {
    cliResult = opts.invoke_cli();
  } catch (err) {
    cliResult = {
      ok: false,
      error: `cli_throw_${cleanText(err && (err.code || err.message) ? (err.code || err.message) : 'unknown', 80)}`
    };
  }
  attempts.push({
    mode: 'cli',
    ok: cliResult && cliResult.ok === true,
    error: cliResult && cliResult.ok !== true ? cliResult.error || 'cli_failed' : null
  });

  if (cliResult && cliResult.ok === true && cliResult.payload && cliResult.payload.ok === true) {
    return {
      ok: true,
      payload: cliResult.payload,
      transport: cleanText(cliResult.transport || 'cli', 40) || 'cli',
      transport_detail: cleanText(cliResult.transport_detail || '', 80) || null,
      fallback_reason: daemonError || inProcessError || null,
      attempts: summarizeAttempts(attempts)
    };
  }

  return {
    ok: false,
    error: toErrorCode(
      cliResult && cliResult.error
        ? cliResult.error
        : (daemonError || inProcessError || 'transport_failed'),
      'transport_failed'
    ),
    status: Number.isFinite(Number(cliResult && cliResult.status))
      ? Number(cliResult.status)
      : 1,
    stderr: cleanText(cliResult && cliResult.stderr ? cliResult.stderr : '', 320),
    stdout: cleanText(cliResult && cliResult.stdout ? cliResult.stdout : '', 320),
    transport: cleanText(cliResult && cliResult.transport ? cliResult.transport : 'cli', 40) || 'cli',
    transport_detail: cleanText(cliResult && cliResult.transport_detail ? cliResult.transport_detail : '', 80) || null,
    fallback_reason: daemonError || inProcessError || null,
    attempts: summarizeAttempts(attempts)
  };
}

function normalizeTransportTelemetry(raw: AnyObj) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    backend_requested: cleanText(src.backend_requested || '', 20) || 'rust',
    backend_used: cleanText(src.backend_used || '', 20) || 'js',
    fallback_reason: src.fallback_reason ? toErrorCode(src.fallback_reason, 'unknown') : null,
    rust_transport: src.rust_transport ? cleanText(src.rust_transport, 40) : null,
    rust_transport_detail: src.rust_transport_detail ? cleanText(src.rust_transport_detail, 80) : null,
    transport_attempts: Array.isArray(src.transport_attempts) ? summarizeAttempts(src.transport_attempts) : []
  };
}

module.exports = {
  runUnifiedMemoryTransport,
  normalizeTransportTelemetry
};
