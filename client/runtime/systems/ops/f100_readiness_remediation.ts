#!/usr/bin/env node
'use strict';

// Thin runtime wrapper: core logic lives in tests/tooling/scripts/ops.

const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const IMPLEMENTATION = path.join(
  ROOT,
  'tests',
  'tooling',
  'scripts',
  'ops',
  'f100_readiness_remediation_impl.js'
);

function run() {
  const outcome = spawnSync(process.execPath, [IMPLEMENTATION], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  if (outcome.error) {
    console.error(
      JSON.stringify({
        ok: false,
        type: 'f100_readiness_remediation_wrapper_error',
        error: String(outcome.error.message || outcome.error),
      })
    );
    return 1;
  }
  return typeof outcome.status === 'number' ? outcome.status : 1;
}

if (require.main === module) {
  process.exit(run());
}

module.exports = {
  run,
};
