#!/usr/bin/env node
'use strict';

// Layer ownership: adapters/polyglot (thin interop bridge over google-adk-bridge)

const bridge = require('../../client/runtime/systems/workflow/google_adk_bridge.ts');

function registerBridge(payload = {}) {
  return bridge.registerRuntimeBridge({
    bridge_path: 'adapters/polyglot/google_adk_runtime_bridge.ts',
    ...payload,
  });
}

function routeModel(payload = {}) {
  return bridge.routeModel(payload);
}

module.exports = {
  registerBridge,
  routeModel,
};
