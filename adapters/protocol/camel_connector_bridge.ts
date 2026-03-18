#!/usr/bin/env node
'use strict';

// Layer ownership: adapters/protocol (thin connector bridge over camel-bridge)

const bridge = require('../../client/runtime/systems/workflow/camel_bridge.ts');

function importDataset(payload = {}) {
  return bridge.importDataset({
    bridge_path: 'adapters/protocol/camel_connector_bridge.ts',
    ...payload,
  });
}

function registerToolGateway(payload = {}) {
  return bridge.registerToolGateway({
    bridge_path: 'adapters/protocol/camel_connector_bridge.ts',
    ...payload,
  });
}

function invokeToolGateway(payload = {}) {
  return bridge.invokeToolGateway(payload);
}

module.exports = {
  importDataset,
  registerToolGateway,
  invokeToolGateway,
};
