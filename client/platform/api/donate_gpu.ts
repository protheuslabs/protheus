#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-022 open-platform compatibility surface.
 * Delegates to canonical systems/economy/public_donation_api lane.
 */

const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const API_SCRIPT = path.join(ROOT, 'systems', 'economy', 'public_donation_api.js');

function main() {
  const args = process.argv.slice(2);
  const proc = spawnSync(process.execPath, [API_SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: process.env
  });
  if (proc.stdout) process.stdout.write(String(proc.stdout));
  if (proc.stderr) process.stderr.write(String(proc.stderr));
  process.exit(Number.isFinite(proc.status) ? Number(proc.status) : 1);
}

main();
