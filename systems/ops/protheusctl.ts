#!/usr/bin/env node
'use strict';
export {};

/**
 * protheusctl.js
 * Typed control client façade over protheus_control_plane.
 */

const path = require('path');
const { spawnSync } = require('child_process');

function usage() {
  console.log('Usage: node systems/ops/protheusctl.js <command> [flags]');
  console.log('Examples:');
  console.log('  node systems/ops/protheusctl.js status');
  console.log('  node systems/ops/protheusctl.js health');
  console.log('  node systems/ops/protheusctl.js job-submit --kind=reconcile');
}

function main() {
  const argv = process.argv.slice(2);
  const cmd = String(argv[0] || 'status');
  const rest = argv.slice(1);
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    usage();
    return;
  }
  const script = path.join(__dirname, 'protheus_control_plane.js');
  const r = spawnSync('node', [script, cmd, ...rest], { encoding: 'utf8' });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  process.exit(Number.isFinite(r.status) ? r.status : 1);
}

main();
