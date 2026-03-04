#!/usr/bin/env node
'use strict';

const path = require('path');
const assert = require('assert');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const inversionPath = path.join(REPO_ROOT, 'systems', 'autonomy', 'inversion_controller.js');
const bridgePath = path.join(REPO_ROOT, 'systems', 'autonomy', 'backlog_autoscale_rust_bridge.js');

function loadInversion(rustEnabled) {
  process.env.INVERSION_RUST_ENABLED = rustEnabled ? '1' : '0';
  delete require.cache[inversionPath];
  delete require.cache[bridgePath];
  return require(inversionPath);
}

function run() {
  const ts = loadInversion(false);
  const rust = loadInversion(true);

  const policy = {
    output_interfaces: {
      default_channel: 'strategy_hint',
      belief_update: {
        enabled: true,
        test_enabled: true,
        live_enabled: false,
        require_sandbox_verification: false,
        require_explicit_emit: false
      },
      strategy_hint: {
        enabled: true,
        test_enabled: true,
        live_enabled: true,
        require_sandbox_verification: false,
        require_explicit_emit: false
      },
      workflow_hint: {
        enabled: false,
        test_enabled: true,
        live_enabled: true,
        require_sandbox_verification: false,
        require_explicit_emit: false
      },
      code_change_proposal: {
        enabled: true,
        test_enabled: true,
        live_enabled: true,
        require_sandbox_verification: true,
        require_explicit_emit: true
      }
    }
  };

  const basePayload = { base: true };
  const opts = {
    sandbox_verified: false,
    emit_code_change_proposal: false,
    channel_payloads: {
      strategy_hint: { hint: 'x' }
    }
  };

  assert.deepStrictEqual(
    rust.buildOutputInterfaces(policy, 'test', basePayload, opts),
    ts.buildOutputInterfaces(policy, 'test', basePayload, opts),
    'buildOutputInterfaces mismatch (test mode)'
  );

  const optsLive = {
    sandbox_verified: true,
    emit_code_change_proposal: true,
    channel_payloads: {
      code_change_proposal: { proposal: 'allowed' }
    }
  };

  assert.deepStrictEqual(
    rust.buildOutputInterfaces(policy, 'live', basePayload, optsLive),
    ts.buildOutputInterfaces(policy, 'live', basePayload, optsLive),
    'buildOutputInterfaces mismatch (live mode)'
  );

  console.log('inversion_helper_batch10_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`inversion_helper_batch10_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
