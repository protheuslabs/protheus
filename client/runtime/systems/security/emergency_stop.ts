#!/usr/bin/env node
// @ts-nocheck
'use strict';
export {};

const path = require('path');
const { spawnSync } = require('child_process');
const JS_ENTRY = path.join(__dirname, 'emergency_stop.js');

if (require.main === module) {
  const out = spawnSync(process.execPath, [JS_ENTRY, ...process.argv.slice(2)], {
    stdio: 'inherit'
  });
  process.exit(Number.isFinite(out && out.status) ? Number(out.status) : 1);
}

module.exports = require('./emergency_stop.js');
