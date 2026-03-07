#!/usr/bin/env node
'use strict';
Object.defineProperty(exports, "__esModule", { value: true });

const { createDomainProxy } = require('../../lib/legacy_conduit_proxy');

const runDomain = createDomainProxy(__dirname, 'PINNACLE', 'pinnacle');

function runViaConduit(command, extraArgs = []) {
  return runDomain([String(command || 'status')].concat(Array.isArray(extraArgs) ? extraArgs : []));
}

function runViaRustBinary(command, extraArgs = []) {
  return runViaConduit(command, extraArgs);
}

function runViaCargo(command, extraArgs = []) {
  return runViaConduit(command, extraArgs);
}

function runCommand(command, left, right, _opts = {}) {
  const leftJson = typeof left === 'string' ? left : JSON.stringify(left && typeof left === 'object' ? left : {});
  const rightJson = typeof right === 'string' ? right : JSON.stringify(right && typeof right === 'object' ? right : {});
  const leftB64 = Buffer.from(leftJson, 'utf8').toString('base64');
  const rightB64 = Buffer.from(rightJson, 'utf8').toString('base64');
  const extraArgs = [`--left-b64=${leftB64}`, `--right-b64=${rightB64}`];
  return runViaConduit(command, extraArgs);
}

function mergeDelta(left, right, opts = {}) {
  return runCommand('merge', left, right, opts);
}

function getSovereigntyIndex(left, right, opts = {}) {
  return runCommand('index', left, right, opts);
}

module.exports = {
  mergeDelta,
  getSovereigntyIndex,
  runViaRustBinary,
  runViaCargo
};
