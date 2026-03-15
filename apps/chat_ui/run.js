#!/usr/bin/env node
'use strict';

const { runProtheusOps } = require('../../client/runtime/systems/ops/run_protheus_ops.js');

const args = process.argv.slice(2);
const commandArgs =
  args.length === 0
    ? ['status', '--app=chat-ui']
    : args;
const normalized =
  commandArgs.some((arg) => arg.startsWith('--app='))
    ? commandArgs
    : [commandArgs[0], '--app=chat-ui', ...commandArgs.slice(1)];

const exit = runProtheusOps(['app-plane', ...normalized]);
process.exit(exit);
