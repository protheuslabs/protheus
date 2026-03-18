#!/usr/bin/env node
'use strict';

const bridge = require('../../client/runtime/systems/workflow/shannon_bridge.ts');

function gatewayRoute(payload = {}) {
  return bridge.gatewayRoute({
    bridge_path: 'adapters/protocol/shannon_gateway_bridge.ts',
    ...payload,
  });
}

function registerTooling(payload = {}) {
  return bridge.registerTooling({
    bridge_path: 'adapters/protocol/shannon_gateway_bridge.ts',
    ...payload,
  });
}

function p2pReliability(payload = {}) {
  return bridge.p2pReliability({
    bridge_path: 'adapters/protocol/shannon_gateway_bridge.ts',
    ...payload,
  });
}

module.exports = {
  gatewayRoute,
  registerTooling,
  p2pReliability,
};
