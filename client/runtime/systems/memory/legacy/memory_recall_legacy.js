#!/usr/bin/env node
'use strict';

// Layer ownership: core/layer1/memory_runtime + core/layer0/ops::memory-ambient (authoritative)
// Legacy compatibility shim only.

const path = require('path');
const { spawnSync } = require('child_process');
const ENTRY = path.join(__dirname, '..', 'memory_recall.js');

if (require.main === module) {
  const out = spawnSync(process.execPath, [ENTRY, ...process.argv.slice(2)], {
    stdio: 'inherit'
  });
  process.exit(Number.isFinite(out && out.status) ? Number(out.status) : 1);
}

module.exports = require('../memory_recall.js');
