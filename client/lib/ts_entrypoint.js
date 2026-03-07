#!/usr/bin/env node
'use strict';

const path = require('path');
const Module = require('module');

const { bootstrap } = require('./ts_bootstrap');

function usage() {
  process.stderr.write('Usage: node client/lib/ts_entrypoint.js <target.ts> [args...]\n');
}

function main() {
  const target = String(process.argv[2] || '').trim();
  if (!target) {
    usage();
    process.exit(2);
  }
  const targetTs = path.resolve(target);
  if (!targetTs.endsWith('.ts')) {
    process.stderr.write(`ts_entrypoint: target must be .ts: ${targetTs}\n`);
    process.exit(2);
  }
  const syntheticJs = targetTs.replace(/\.ts$/i, '.js');
  const forwardedArgs = process.argv.slice(3);
  process.argv = [process.argv[0], syntheticJs, ...forwardedArgs];

  const entry = new Module(syntheticJs, module.parent || module);
  entry.id = '.';
  entry.filename = syntheticJs;
  entry.paths = Module._nodeModulePaths(path.dirname(syntheticJs));
  require.main = entry;
  process.mainModule = entry;
  bootstrap(syntheticJs, entry);
}

main();
