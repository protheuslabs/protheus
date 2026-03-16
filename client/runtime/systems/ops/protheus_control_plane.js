#!/usr/bin/env node
'use strict';

// Thin bridge to core authority: protheus-control-plane domain.

const { runProtheusOps } = require('./run_protheus_ops.js');

function normalizeSubcommand(raw) {
  const sub = String(raw || 'status').trim().toLowerCase();
  if (sub === 'health') return 'status';
  if (sub === 'job-submit') return 'run';
  if (sub === 'audit') return 'run';
  return sub || 'status';
}

function run(argv = process.argv.slice(2)) {
  const sub = normalizeSubcommand(argv[0]);
  const rest = argv.slice(1);
  const args = ['protheus-control-plane', sub].concat(rest);
  return runProtheusOps(args, { unknownDomainFallback: true });
}

if (require.main === module) {
  process.exit(run(process.argv.slice(2)));
}

module.exports = { run, normalizeSubcommand };

