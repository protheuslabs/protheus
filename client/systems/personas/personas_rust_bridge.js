#!/usr/bin/env node
'use strict';
Object.defineProperty(exports, "__esModule", { value: true });

const { createDomainProxy } = require('../../lib/legacy_conduit_proxy');

const runDomain = createDomainProxy(__dirname, 'PERSONAS', 'personas-cli');

function runViaConduit(payloadBase64) {
  return runDomain(['primitive', `--payload-base64=${String(payloadBase64 || '')}`]);
}

function runViaRustBinary(payloadBase64) {
  return runViaConduit(payloadBase64);
}

function runViaCargo(payloadBase64) {
  return runViaConduit(payloadBase64);
}

function runPersonasPrimitive(mode, data = {}, _opts = {}) {
  const normalizedMode = String(mode || '').trim().toLowerCase();
  if (!normalizedMode) {
    return { ok: false, error: 'personas_mode_missing', engine: 'conduit', routed_via: 'conduit' };
  }
  const request = {
    mode: normalizedMode,
    input: data && typeof data === 'object' ? data : {}
  };
  const payloadBase64 = Buffer.from(JSON.stringify(request), 'utf8').toString('base64');
  return runViaConduit(payloadBase64);
}

module.exports = {
  runPersonasPrimitive,
  runViaRustBinary,
  runViaCargo
};
