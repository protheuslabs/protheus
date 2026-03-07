#!/usr/bin/env node
'use strict';

const { createOpsLaneBridge } = require('./rust_lane_bridge');

function cleanText(v, maxLen = 260) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function createDomainProxy(scriptDir, lane, domain) {
  const bridge = createOpsLaneBridge(scriptDir, lane, domain);
  return function run(args = []) {
    const out = bridge.run(Array.isArray(args) ? args : []);
    if (out && out.ok === true && out.payload && typeof out.payload === 'object') {
      return {
        ok: true,
        engine: 'conduit',
        payload: out.payload,
        status: Number.isFinite(Number(out.status)) ? Number(out.status) : 0,
        routed_via: 'conduit'
      };
    }
    return {
      ok: false,
      engine: 'conduit',
      payload: out && out.payload && typeof out.payload === 'object' ? out.payload : null,
      status: Number.isFinite(Number(out && out.status)) ? Number(out.status) : 1,
      routed_via: 'conduit',
      error: cleanText((out && (out.stderr || out.stdout)) || (out && out.payload && out.payload.reason) || 'conduit_domain_failed', 300)
    };
  };
}

module.exports = {
  createDomainProxy
};
