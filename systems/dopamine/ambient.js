#!/usr/bin/env node
'use strict';

const path = require('path');
const { runDopamineAmbientCommand } = require('../../lib/spine_conduit_bridge');

const ROOT = path.resolve(__dirname, '..', '..');

async function run(args = [], opts = {}) {
  const routed = Array.isArray(args) && args.length > 0 ? args : ['status'];
  return runDopamineAmbientCommand(routed, {
    cwdHint: opts.cwdHint || ROOT
  });
}

async function main() {
  const out = await run(process.argv.slice(2));
  if (out.payload) {
    process.stdout.write(`${JSON.stringify(out.payload)}\n`);
  } else if (out.stdout) {
    process.stdout.write(String(out.stdout));
  }
  if (out.stderr) {
    process.stderr.write(String(out.stderr));
    if (!String(out.stderr).endsWith('\n')) process.stderr.write('\n');
  }
  process.exit(Number.isFinite(out.status) ? Number(out.status) : 1);
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`${String(err && err.message ? err.message : err)}\n`);
    process.exit(1);
  });
}

module.exports = {
  run
};
