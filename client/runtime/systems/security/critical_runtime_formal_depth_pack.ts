#!/usr/bin/env node
// @ts-nocheck
'use strict';
export {};

// Layer ownership: core/layer1/security::critical-runtime-formal-depth-pack (authoritative)
// TypeScript compatibility shim only.
const path = require('path');
const { spawnSync } = require('child_process');

const JS_ENTRY = path.join(__dirname, 'critical_runtime_formal_depth_pack.js');

if (require.main === module) {
  const out = spawnSync(process.execPath, [JS_ENTRY, ...process.argv.slice(2)], {
    stdio: 'inherit'
  });
  process.exit(Number.isFinite(out && out.status) ? Number(out.status) : 1);
}

module.exports = require('./critical_runtime_formal_depth_pack.js');
