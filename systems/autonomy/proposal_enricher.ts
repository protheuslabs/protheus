#!/usr/bin/env node
'use strict';
export {};

/**
 * Rust cutover wrapper for proposal_enricher.
 *
 * CLI invocations route through Rust protheus-ops-core.
 * Module imports remain compatible via legacy exports until full Rust parity lands.
 */

const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const legacy = require('./proposal_enricher_legacy.js');

function runRustCli() {
  const args = process.argv.slice(2);
  const cargoArgs = [
    'run',
    '--quiet',
    '--manifest-path',
    'crates/ops/Cargo.toml',
    '--',
    'autonomy-proposal-enricher',
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
