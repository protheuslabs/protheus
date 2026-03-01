#!/usr/bin/env node
'use strict';
export {};

/**
 * protheusd.js
 * Daemon façade over protheus_control_plane to provide split daemon/client UX.
 */

const path = require('path');
const { spawnSync } = require('child_process');

function usage() {
  console.log('Usage: node systems/ops/protheusd.js start|stop|restart|status|tick [--policy=<path>]');
}

function run(command, extraArgs) {
  const script = path.join(__dirname, 'protheus_control_plane.js');
  const args = [script, command, ...extraArgs];
  const r = spawnSync('node', args, { encoding: 'utf8' });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  process.exit(Number.isFinite(r.status) ? r.status : 1);
}

function main() {
  const argv = process.argv.slice(2);
  const cmd = String(argv[0] || 'status');
  const rest = argv.slice(1);
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    usage();
    return;
  }
  if (cmd === 'tick') {
    run('job-runner', rest);
    return;
  }
  run(cmd, rest);
}

main();
