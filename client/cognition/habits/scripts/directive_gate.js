#!/usr/bin/env node
/**
 * Compatibility wrapper.
 * Moved to: client/runtime/systems/security/directive_gate.js
 */

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const candidates = [
  path.resolve(__dirname, '..', '..', '..', 'runtime', 'systems', 'security', 'directive_gate.js'),
  path.resolve(__dirname, '..', '..', 'systems', 'security', 'directive_gate.js')
];
const target = candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0];

if (require.main === module) {
  const r = spawnSync(process.execPath, [target, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: process.env
  });
  process.exit(r.status == null ? 1 : r.status);
}

module.exports = require(target);
