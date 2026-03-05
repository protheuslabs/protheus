#!/usr/bin/env node
'use strict';

if (process.argv.includes('--help') || process.argv.includes('-h') || process.argv.includes('help')) {
  console.log('autonomy_controller.js run evidence readiness status');
  process.exit(0);
}

require('../../lib/ts_bootstrap').bootstrap(__filename, module);
