#!/usr/bin/env node
'use strict';
export {};

/**
 * Rust cutover wrapper for foundation_contract_gate.
 *
 * Exact gate semantics are preserved through the Rust bridge and legacy implementation.
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
    'foundation-contract-gate',
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
}
