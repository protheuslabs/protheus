#!/usr/bin/env node
/**
 * Compatibility wrapper.
 * Moved to: client/systems/security/directive_gate.js
 */

const path = require('path');
const { spawnSync } = require('child_process');

const target = path.resolve(__dirname, '..', '..', 'systems', 'security', 'directive_gate.js');

if (require.main === module) {
  const r = spawnSync(process.execPath, [target, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: process.env
  });
  process.exit(r.status == null ? 1 : r.status);
}

module.exports = require(target);
