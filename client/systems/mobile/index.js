#!/usr/bin/env node
'use strict';
Object.defineProperty(exports, "__esModule", { value: true });

const { createDomainProxy } = require('../../lib/legacy_conduit_proxy');

const runDomain = createDomainProxy(__dirname, 'MOBILE', 'mobile');

function runViaConduitRequest(requestBase64) {
  return runDomain(['run', `--request-base64=${String(requestBase64 || '')}`]);
}

function runViaRustBinary(requestBase64) {
  return runViaConduitRequest(requestBase64);
}

function runViaCargo(requestBase64) {
  return runViaConduitRequest(requestBase64);
}

function runMobileCycle(request, _opts = {}) {
  const requestJson = typeof request === 'string'
    ? request
    : JSON.stringify(request && typeof request === 'object' ? request : {});
  const requestBase64 = Buffer.from(String(requestJson || '{}'), 'utf8').toString('base64');
  return runViaConduitRequest(requestBase64);
}

module.exports = {
  runMobileCycle,
  runViaRustBinary,
  runViaCargo
};
