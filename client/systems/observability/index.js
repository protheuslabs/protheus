#!/usr/bin/env node
'use strict';
Object.defineProperty(exports, "__esModule", { value: true });

const { createDomainProxy } = require('../../lib/legacy_conduit_proxy');

const runDomain = createDomainProxy(__dirname, 'OBSERVABILITY', 'health-status');

function cleanText(v, maxLen = 240) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeChaosPayloadLegacyCompat(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  const sovereignty = payload.sovereignty && typeof payload.sovereignty === 'object'
    ? payload.sovereignty
    : {};
  const telemetry = Number(payload.telemetry_overhead_ms || 0);
  const battery = Number(payload.chaos_battery_pct_24h || 0);
  const failClosed = Boolean(sovereignty.fail_closed);
  const resilient = failClosed !== true && telemetry <= 1.0 && battery <= 3.0;
  return { ...payload, resilient };
}

function runViaConduit(command, extraArgs = []) {
  return runDomain([String(command || 'status')].concat(Array.isArray(extraArgs) ? extraArgs : []));
}

function runViaRustBinary(command, extraArgs = []) {
  return runViaConduit(command, extraArgs);
}

function runViaCargo(command, extraArgs = []) {
  return runViaConduit(command, extraArgs);
}

function loadWasmBindgenBridge() {
  return {
    ok: false,
    error: 'observability_wasm_bridge_disabled_use_conduit'
  };
}

function loadEmbeddedObservabilityProfile(_opts = {}) {
  return runViaConduit('status');
}

function runChaosObservability(request, _opts = {}) {
  const requestJson = typeof request === 'string'
    ? request
    : JSON.stringify(request && typeof request === 'object' ? request : {});
  const requestBase64 = Buffer.from(String(requestJson || '{}'), 'utf8').toString('base64');
  const out = runViaConduit('run-chaos', [`--request-base64=${requestBase64}`]);
  if (!out || out.ok !== true) return out;
  return {
    ...out,
    payload: normalizeChaosPayloadLegacyCompat(out.payload)
  };
}

module.exports = {
  loadEmbeddedObservabilityProfile,
  runChaosObservability,
  loadWasmBindgenBridge,
  runViaRustBinary,
  runViaCargo,
  cleanText
};
