#!/usr/bin/env node
'use strict';

// Layer ownership: adapters/protocol (thin protocol bridge over pydantic-ai-bridge)

const bridge = require('../../client/runtime/systems/workflow/pydantic_ai_bridge.ts');

function registerToolContext(payload = {}) {
  return bridge.registerToolContext({
    bridge_path: 'adapters/protocol/pydantic_ai_protocol_bridge.ts',
    ...payload,
  });
}

function invokeToolContext(payload = {}) {
  return bridge.invokeToolContext(payload);
}

function bridgeProtocol(payload = {}) {
  return bridge.bridgeProtocol({
    bridge_path: 'adapters/protocol/pydantic_ai_protocol_bridge.ts',
    ...payload,
  });
}

function streamModel(payload = {}) {
  return bridge.streamModel(payload);
}

module.exports = {
  registerToolContext,
  invokeToolContext,
  bridgeProtocol,
  streamModel,
};
