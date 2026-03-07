#!/usr/bin/env node
'use strict';
Object.defineProperty(exports, "__esModule", { value: true });

const { createDomainProxy } = require('../../lib/legacy_conduit_proxy');

const runDomain = createDomainProxy(__dirname, 'GRAPH', 'graph');

function runViaConduit(command, yamlBase64) {
  return runDomain([String(command || 'status'), `--yaml-base64=${String(yamlBase64 || '')}`]);
}

function runViaRustBinary(command, yamlBase64) {
  return runViaConduit(command, yamlBase64);
}

function runViaCargo(command, yamlBase64) {
  return runViaConduit(command, yamlBase64);
}

function runGraphWorkflow(yamlOrSpec, _opts = {}) {
  const yaml = typeof yamlOrSpec === 'string'
    ? yamlOrSpec
    : JSON.stringify(yamlOrSpec && typeof yamlOrSpec === 'object' ? yamlOrSpec : {});
  const b64 = Buffer.from(yaml, 'utf8').toString('base64');
  return runViaConduit('run', b64);
}

function vizGraphWorkflow(yamlOrSpec, _opts = {}) {
  const yaml = typeof yamlOrSpec === 'string'
    ? yamlOrSpec
    : JSON.stringify(yamlOrSpec && typeof yamlOrSpec === 'object' ? yamlOrSpec : {});
  const b64 = Buffer.from(yaml, 'utf8').toString('base64');
  return runViaConduit('viz', b64);
}

module.exports = {
  runGraphWorkflow,
  vizGraphWorkflow,
  runViaRustBinary,
  runViaCargo
};
