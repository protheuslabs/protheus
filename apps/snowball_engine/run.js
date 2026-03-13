#!/usr/bin/env node
'use strict';

const { runProtheusOps } = require('../_shared/run_protheus_ops.js');

const args = process.argv.slice(2);
const commandArgs = args.length === 0 ? ['status'] : args;

const exit = runProtheusOps(['snowball-plane', ...commandArgs]);
process.exit(exit);

