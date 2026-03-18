#!/usr/bin/env node
'use strict';

const assert = require('node:assert');
const path = require('node:path');
const Module = require('node:module');

const ROOT = path.resolve(__dirname, '../..');
const TARGET = path.join(ROOT, 'client', 'runtime', 'lib', 'rust_lane_bridge.ts');

function clearTarget() {
  delete require.cache[require.resolve(TARGET)];
}

function main() {
  const originalLoad = Module._load;
  let spawnCalls = [];

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'child_process') {
      const real = originalLoad.apply(this, arguments);
      return {
        ...real,
        spawnSync(command, args, options) {
          spawnCalls.push({ command, args, cwd: options && options.cwd });
          if (spawnCalls.length === 1) {
            return {
              error: Object.assign(new Error('spawnSync target/debug/protheus-ops ENOENT'), {
                code: 'ENOENT'
              }),
              status: null,
              stdout: '',
              stderr: ''
            };
          }
          return {
            error: null,
            status: 0,
            stdout: `${JSON.stringify({ ok: true, type: 'cargo_retry_success' })}\n`,
            stderr: ''
          };
        }
      };
    }
    return originalLoad.apply(this, arguments);
  };

  try {
    process.env.PROTHEUS_OPS_USE_PREBUILT = '1';
    process.env.PROTHEUS_OPS_PREFER_CARGO = '0';
    clearTarget();
    const bridgeModule = require(TARGET);
    const bridge = bridgeModule.createOpsLaneBridge(
      path.join(ROOT, 'client', 'runtime', 'lib'),
      'rust_lane_bridge_fallback_test',
      'directive-kernel',
      { preferLocalCore: true }
    );

    const result = bridge.run(['status']);
    assert.equal(result.status, 0);
    assert.equal(result.payload.type, 'cargo_retry_success');
    assert.equal(result.fallback_reason, 'stale_prebuilt_retry');
    assert.equal(spawnCalls.length, 2);
    assert.notEqual(spawnCalls[0].command, 'cargo');
    assert.equal(spawnCalls[1].command, 'cargo');
  } finally {
    Module._load = originalLoad;
    clearTarget();
    delete process.env.PROTHEUS_OPS_USE_PREBUILT;
    delete process.env.PROTHEUS_OPS_PREFER_CARGO;
  }

  console.log(JSON.stringify({ ok: true, type: 'rust_lane_bridge_fallback_test' }));
}

if (require.main === module) {
  main();
}

module.exports = { main };
