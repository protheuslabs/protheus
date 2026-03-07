#!/usr/bin/env node
'use strict';
Object.defineProperty(exports, "__esModule", { value: true });

const { createDomainProxy } = require('../../lib/legacy_conduit_proxy');

const runDomain = createDomainProxy(__dirname, 'SINGULARITY_SEED', 'singularity-seed');

function runViaRustBinary(command, extraArgs = []) {
  return runDomain([String(command || 'status')].concat(Array.isArray(extraArgs) ? extraArgs : []));
}

function runViaCargo(command, extraArgs = []) {
  return runViaRustBinary(command, extraArgs);
}

function runCommand(command, opts = {}) {
  const request = opts.request && typeof opts.request === 'object' ? opts.request : null;
  const extraArgs = [];
  if (request) {
    const base64 = Buffer.from(JSON.stringify(request), 'utf8').toString('base64');
    extraArgs.push(`--request-base64=${base64}`);
  }
  return runViaRustBinary(command, extraArgs);
}

function freezeSeedLoops(opts = {}) {
  return runCommand('freeze', opts);
}

function runSingularitySeedCycle(opts = {}) {
  const request = opts.request && typeof opts.request === 'object' ? opts.request : {};
  return runCommand('cycle', { ...opts, request });
}

function showSingularitySeedState(opts = {}) {
  return runCommand('show', opts);
}

module.exports = {
  freezeSeedLoops,
  runSingularitySeedCycle,
  showSingularitySeedState,
  runViaRustBinary,
  runViaCargo
};
