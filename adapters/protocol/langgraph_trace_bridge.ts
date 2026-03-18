#!/usr/bin/env node
'use strict';

// Layer ownership: adapters/protocol (thin protocol bridge over langgraph-bridge)

const bridge = require('../../client/runtime/systems/workflow/langgraph_bridge.ts');

function recordTrace(payload = {}) {
  return bridge.recordTrace({
    bridge_path: 'adapters/protocol/langgraph_trace_bridge.ts',
    ...payload,
  });
}

function streamGraph(payload = {}) {
  return bridge.streamGraph(payload);
}

module.exports = {
  recordTrace,
  streamGraph,
};
