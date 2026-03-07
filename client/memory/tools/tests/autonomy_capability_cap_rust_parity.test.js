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

function run() {
  const rows = [
    {
      budget: {
        per_capability_caps: {
          'proposal:ops_remediation': 4.2,
          proposal: 2
        }
      },
      descriptor: {
        key: 'proposal:ops_remediation',
        aliases: ['proposal']
      }
    },
    {
      budget: {
        per_capability_caps: {
          proposal: 3
        }
      },
      descriptor: {
        key: 'proposal:feature',
        aliases: ['proposal']
      }
    },
    {
      budget: {
        per_capability_caps: {}
      },
      descriptor: {
        key: 'proposal:feature',
        aliases: []
      }
    }
  ];

  const tsController = loadController(false);
  const rustController = loadController(true);

  for (const row of rows) {
    const tsOut = tsController.capabilityCap(row.budget, row.descriptor);
    const rustOut = rustController.capabilityCap(row.budget, row.descriptor);
    assert.strictEqual(
      rustOut,
      tsOut,
      `capabilityCap parity mismatch for ${JSON.stringify(row)}`
    );
  }

  console.log('autonomy_capability_cap_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_capability_cap_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
