#!/usr/bin/env node
'use strict';
export {};

/**
 * Rust cutover wrapper for autonomy_controller.
 *
 * - Preserves CLI path (`node systems/autonomy/autonomy_controller.js ...`)
 * - Delegates execution to Rust domain in `crates/ops`
 * - Re-exports legacy module API for existing JS/TS callers
 */

const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const legacy = require('./autonomy_controller_legacy.js');

function runRustCli() {
  const args = process.argv.slice(2);
  const cargoArgs = [
    'run',
    '--quiet',
    '--manifest-path',
    'crates/ops/Cargo.toml',
    '--',
    'autonomy-controller',
    ...args
  ];

  const run = spawnSync('cargo', cargoArgs, {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      PROTHEUS_NODE_BINARY: process.execPath || 'node'
    }
  });

  if (run.stdout) process.stdout.write(run.stdout);
  if (run.stderr) process.stderr.write(run.stderr);
  process.exit(Number.isFinite(run.status) ? run.status : 1);
}

if (require.main === module) {
  runRustCli();
}

module.exports = legacy;
