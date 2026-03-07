#!/usr/bin/env node
'use strict';

const path = require('path');
const assert = require('assert');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const autonomyPath = path.join(REPO_ROOT, 'systems', 'autonomy', 'autonomy_controller.js');
const bridgePath = path.join(REPO_ROOT, 'systems', 'autonomy', 'backlog_autoscale_rust_bridge.js');

function loadAutonomy(rustEnabled) {
  process.env.AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED = rustEnabled ? '1' : '0';
  delete require.cache[autonomyPath];
  delete require.cache[bridgePath];
  return require(autonomyPath);
}

function normalize(out) {
  const row = out && typeof out === 'object' ? out : {};
  return {
    enabled: row.enabled === true,
    applicable: row.applicable === true,
    pass: row.pass === true,
    reason: String(row.reason || ''),
    capability_key: row.capability_key == null ? null : String(row.capability_key),
    attempts: Number(row.attempts || 0),
    route_blocked: Number(row.route_blocked || 0),
    route_block_rate: Number(Number(row.route_block_rate || 0).toFixed(3))
  };
}

function run() {
  const ts = loadAutonomy(false);
  const rust = loadAutonomy(true);

  const telemetry = {
    by_capability: {
      deploy: {
        attempts: 8,
        route_blocked: 3,
        route_block_rate: 0.375
      }
    }
  };

  const tsOut = normalize(ts.evaluateRouteBlockPrefilter(telemetry, 'deploy'));
  const rustOut = normalize(rust.evaluateRouteBlockPrefilter(telemetry, 'deploy'));
  assert.deepStrictEqual(rustOut, tsOut, 'evaluateRouteBlockPrefilter mismatch');

  console.log('autonomy_route_block_prefilter_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_route_block_prefilter_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
