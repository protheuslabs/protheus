#!/usr/bin/env node
'use strict';

// Layer ownership: adapters/protocol (thin connector bridge over dify-bridge)

const bridge = require('../../client/runtime/systems/workflow/dify_bridge.ts');

function syncKnowledgeBase(payload = {}) {
  return bridge.syncKnowledgeBase({
    bridge_path: 'adapters/protocol/dify_connector_bridge.ts',
    ...payload,
  });
}

function registerAgentApp(payload = {}) {
  return bridge.registerAgentApp({
    bridge_path: 'adapters/protocol/dify_connector_bridge.ts',
    ...payload,
  });
}

function routeProvider(payload = {}) {
  return bridge.routeProvider({
    bridge_path: 'adapters/protocol/dify_connector_bridge.ts',
    ...payload,
  });
}

module.exports = {
  syncKnowledgeBase,
  registerAgentApp,
  routeProvider,
};
