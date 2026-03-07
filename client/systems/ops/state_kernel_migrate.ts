#!/usr/bin/env node
'use strict';
export {};

/**
 * state_kernel_migrate.js
 *
 * Dedicated migration tool for V3-SK schema evolution + rollback receipts.
 */

const path = require('path');

const stateKernel = require('./state_kernel');

type AnyObj = Record<string, any>;

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (const tok of argv) {
    if (!String(tok || '').startsWith('--')) {
      out._.push(String(tok || ''));
      continue;
    }
    const idx = tok.indexOf('=');
    if (idx < 0) out[String(tok).slice(2)] = true;
    else out[String(tok).slice(2, idx)] = String(tok).slice(idx + 1);
  }
  return out;
}

function normalizeToken(v: unknown, maxLen = 80) {
  return String(v == null ? '' : v)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.:/-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, maxLen);
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/state_kernel_migrate.js run [--policy=path] [--strict=1|0] [--actor=<id>]');
  console.log('  node systems/ops/state_kernel_migrate.js status [--policy=path]');
}

function cmdRun(args: AnyObj) {
  const policyPath = args.policy ? path.resolve(String(args.policy)) : stateKernel.DEFAULT_POLICY_PATH;
  const policy = stateKernel.loadPolicy(policyPath);
  const out = stateKernel.applyMigrations(policy, {
    strict: args.strict,
    actor: args.actor || process.env.USER || 'state_kernel_migrate'
  });
  return {
    ...out,
    type: 'state_kernel_migrate_run',
    policy_path: path.relative(path.resolve(__dirname, '..', '..'), policyPath).replace(/\\/g, '/')
  };
}

function cmdStatus(args: AnyObj) {
  const policyPath = args.policy ? path.resolve(String(args.policy)) : stateKernel.DEFAULT_POLICY_PATH;
  const policy = stateKernel.loadPolicy(policyPath);
  const status = stateKernel.status(policy);
  return {
    ok: status.ok === true,
    type: 'state_kernel_migrate_status',
    ts: new Date().toISOString(),
    migration_receipts_count: Number(status.migration && status.migration.receipts_count || 0),
    policy_path: path.relative(path.resolve(__dirname, '..', '..'), policyPath).replace(/\\/g, '/'),
    db_path: status.sqlite && status.sqlite.db_path ? status.sqlite.db_path : null,
    parity: status.parity || null
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || 'status', 80) || 'status';
  if (cmd === 'help' || args.help) {
    usage();
    process.exit(0);
  }
  let out: AnyObj;
  try {
    if (cmd === 'run') out = cmdRun(args);
    else if (cmd === 'status') out = cmdStatus(args);
    else out = { ok: false, type: 'state_kernel_migrate', error: `unknown_command:${cmd}` };
  } catch (err) {
    out = {
      ok: false,
      type: 'state_kernel_migrate',
      error: String(err && (err as AnyObj).message ? (err as AnyObj).message : err || 'state_kernel_migrate_failed').slice(0, 260)
    };
  }
  process.stdout.write(`${JSON.stringify(out)}\n`);
  if (out.ok !== true) process.exitCode = 1;
}

if (require.main === module) {
  main();
}

module.exports = {
  cmdRun,
  cmdStatus
};
