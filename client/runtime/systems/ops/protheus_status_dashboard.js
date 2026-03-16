#!/usr/bin/env node
'use strict';

// Compatibility wrapper: dashboard requests route to control-plane status.

const { run } = require('./protheus_control_plane.js');

if (require.main === module) {
  process.exit(run(['status'].concat(process.argv.slice(2))));
}

module.exports = { run };

