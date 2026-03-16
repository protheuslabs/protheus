#!/usr/bin/env node
'use strict';

// Compatibility wrapper: diagnostics uses control-plane run/status routes.

const { run } = require('./protheus_control_plane.js');

if (require.main === module) {
  const argv = process.argv.slice(2);
  const sub = argv[0] ? String(argv[0]).toLowerCase() : 'status';
  if (sub === 'status' || sub === 'health') {
    process.exit(run(['status'].concat(argv.slice(1))));
  }
  process.exit(run(['run'].concat(argv)));
}

module.exports = { run };

