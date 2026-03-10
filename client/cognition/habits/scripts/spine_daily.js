#!/usr/bin/env node
'use strict';

// Layer ownership: apps/habits/scripts (authoritative)
// Thin compatibility wrapper only.
const path = require('path');
const { spawnSync } = require('child_process');
const target = path.resolve(__dirname, '../../../../apps/habits/scripts/spine_daily.js');

function run(args = process.argv.slice(2)) {
  const r = spawnSync(process.execPath, [target, ...args], {
    stdio: 'inherit',
    env: process.env
  });
  return r.status == null ? 1 : r.status;
}

if (require.main === module) {
  process.exit(run(process.argv.slice(2)));
}

module.exports = { run };
