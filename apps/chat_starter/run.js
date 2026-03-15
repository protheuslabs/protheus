#!/usr/bin/env node
'use strict';

const { runProtheusOps } = require('../../client/runtime/systems/ops/run_protheus_ops.js');

const args = process.argv.slice(2);
const commandArgs =
  args.length === 0
    ? ['run', '--app=chat-starter', '--message=hello from chat_starter']
    : args;
const normalized =
  commandArgs.some((arg) => arg.startsWith('--app=')) || commandArgs[0] === 'status'
    ? commandArgs
    : [commandArgs[0], '--app=chat-starter', ...commandArgs.slice(1)];

const exit = runProtheusOps(['app-plane', ...normalized]);
process.exit(exit);
