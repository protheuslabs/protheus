#!/usr/bin/env node
'use strict';

if (process.argv.includes('--help') || process.argv.includes('-h') || process.argv.includes('help')) {
  console.log('protheusctl job-submit status health');
  process.exit(0);
}

require('../../lib/ts_bootstrap').bootstrap(__filename, module);
