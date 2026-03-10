#!/usr/bin/env node
'use strict';

// Layer ownership: core/layer0/memory_runtime::idle_dream_cycle (authoritative)
// Legacy compatibility shim only.

const path = require('path');
const { spawnSync } = require('child_process');
const ENTRY = path.join(__dirname, '..', 'idle_dream_cycle.js');

if (require.main === module) {
  const out = spawnSync(process.execPath, [ENTRY, ...process.argv.slice(2)], {
    stdio: 'inherit'
  });
  process.exit(Number.isFinite(out && out.status) ? Number(out.status) : 1);
}

module.exports = require('../idle_dream_cycle.js');
