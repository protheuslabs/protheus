#!/usr/bin/env node
'use strict';

// Layer ownership: adapters/protocol (thin protocol bridge over crewai-bridge)

const bridge = require('../../client/runtime/systems/workflow/crewai_bridge.ts');

function ingestConfig(payload = {}) {
  return bridge.ingestConfig({
    bridge_path: 'adapters/protocol/crewai_tool_bridge.ts',
    ...payload,
  });
}

function routeDelegation(payload = {}) {
  return bridge.routeDelegation({
    bridge_path: 'adapters/protocol/crewai_tool_bridge.ts',
    ...payload,
  });
}

function routeModel(payload = {}) {
  return bridge.routeModel({
    bridge_path: 'adapters/protocol/crewai_tool_bridge.ts',
    ...payload,
  });
}

module.exports = {
  ingestConfig,
  routeDelegation,
  routeModel,
};
