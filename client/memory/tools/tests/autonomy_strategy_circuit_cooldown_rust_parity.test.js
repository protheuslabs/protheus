#!/usr/bin/env node
'use strict';

const path = require('path');
const assert = require('assert');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const controllerPath = path.join(REPO_ROOT, 'systems', 'autonomy', 'autonomy_controller.js');
const bridgePath = path.join(REPO_ROOT, 'systems', 'autonomy', 'backlog_autoscale_rust_bridge.js');

function loadController(rustEnabled) {
  process.env.AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED = rustEnabled ? '1' : '0';
  delete require.cache[controllerPath];
  delete require.cache[bridgePath];
  return require(controllerPath);
}

function proposal(lastErrorCode, lastError) {
  return {
    meta: {
      last_error_code: lastErrorCode,
      last_error: lastError
    }
  };
}

function strategy() {
  return {
    stop_policy: {
      circuit_breakers: {
        http_429_cooldown_hours: 2,
        http_5xx_cooldown_hours: 6,
        dns_error_cooldown_hours: 3
      }
    }
  };
}

function run() {
  const rows = [
    proposal('HTTP 429', null),
    proposal('server_error_503', null),
    proposal(null, 'ENOTFOUND host'),
    proposal('none', 'noop')
  ];

  const tsController = loadController(false);
  const rustController = loadController(true);
  const policy = strategy();

  for (const row of rows) {
    const tsOut = tsController.strategyCircuitCooldownHours(row, policy);
    const rustOut = rustController.strategyCircuitCooldownHours(row, policy);
    assert.strictEqual(
      rustOut,
      tsOut,
      `strategyCircuitCooldownHours parity mismatch for ${JSON.stringify(row)}`
    );
  }

  console.log('autonomy_strategy_circuit_cooldown_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_strategy_circuit_cooldown_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
