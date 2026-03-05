#!/usr/bin/env node
'use strict';

if (process.argv.includes('--help') || process.argv.includes('-h') || process.argv.includes('help')) {
  console.log('rust_memory_transition_lane.js pilot benchmark consistency-check index-probe selector auto-selector soak-gate retire-check status');
  process.exit(0);
}

require('../../lib/ts_bootstrap').bootstrap(__filename, module);
