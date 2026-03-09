#!/usr/bin/env node
'use strict';

const path = require('path');
const { spawnSync } = require('child_process');
const RUNTIME_ENTRY = path.join(__dirname, '..', '..', 'runtime', 'systems', 'spine', 'background_hands_scheduler.js');

if (require.main === module) {
  const out = spawnSync(process.execPath, [RUNTIME_ENTRY, ...process.argv.slice(2)], {
    stdio: 'inherit'
  });
  process.exit(Number.isFinite(out && out.status) ? Number(out.status) : 1);
}

module.exports = require(RUNTIME_ENTRY);
