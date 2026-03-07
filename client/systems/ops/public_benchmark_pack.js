#!/usr/bin/env node
'use strict';

const path = require('path');

process.argv = [
  process.argv[0],
  process.argv[1],
  path.resolve(__dirname, 'public_benchmark_pack.ts'),
  ...process.argv.slice(2)
];

require(path.resolve(__dirname, '..', '..', 'lib', 'ts_entrypoint.js'));
