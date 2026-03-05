#!/usr/bin/env node
'use strict';
export {};

/**
 * Rust cutover wrapper for state_kernel.
 *
 * CLI invocations route through Rust.
 * Module imports keep using the legacy bridge API for compatibility
 * until dependent TS callers are fully migrated.
 */

const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');

function main() {
  const args = process.argv.slice(2);
  const cargoArgs = [
    'run',
    '--quiet',
    '--manifest-path',
    'crates/ops/Cargo.toml',
    '--',
    'state-kernel',
    ...args
  ];

  const run = spawnSync('cargo', cargoArgs, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: 'inherit',
    env: {
      ...process.env,
      PROTHEUS_NODE_BINARY: process.execPath || 'node'
    }
  });

  process.exit(Number.isFinite(run.status) ? run.status : 1);
}

if (require.main === module) {
  main();
} else {
  module.exports = require('./state_kernel_legacy');
}
