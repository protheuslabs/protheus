#!/usr/bin/env node
'use strict';

// Layer ownership: adapters/protocol (thin protocol bridge over dspy-bridge)

const bridge = require('../../client/runtime/systems/workflow/dspy_bridge.ts');

function importIntegration(payload = {}) {
  return bridge.importIntegration({
    bridge_path: 'adapters/protocol/dspy_program_bridge.ts',
    ...payload,
  });
}

function executeMultihop(payload = {}) {
  return bridge.executeMultihop(payload);
}

function recordBenchmark(payload = {}) {
  return bridge.recordBenchmark(payload);
}

module.exports = {
  importIntegration,
  executeMultihop,
  recordBenchmark,
};
