#!/usr/bin/env node
'use strict';

/**
 * merge_guard.js
 *
 * Non-bypass local merge guard for required checks.
 *
 * Usage:
 *   node systems/security/merge_guard.js run [--skip-tests]
 *   node systems/security/merge_guard.js --help
 */

const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');

function usage() {
  console.log('Usage:');
  console.log('  node systems/security/merge_guard.js run [--skip-tests]');
  console.log('  node systems/security/merge_guard.js --help');
}

function parseArgs(argv) {
  const out = { _: [] } as Record<string, any>;
  for (const arg of argv) {
    if (!arg.startsWith('--')) {
      out._.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq === -1) out[arg.slice(2)] = true;
    else out[arg.slice(2, eq)] = arg.slice(eq + 1);
  }
  return out;
}

function runCmd(name, command, args) {
  const r = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8'
  });
  const ok = r.status === 0;
  return {
    name,
    ok,
    status: Number(r.status || 0),
    command: [command, ...args].join(' '),
    stdout: String(r.stdout || '').trim(),
    stderr: String(r.stderr || '').trim()
  };
}

function runGuard(opts = {}) {
  const options = (opts && typeof opts === 'object' ? opts : {}) as Record<string, any>;
  const checks = [];
  checks.push(runCmd('contract_check', 'node', ['systems/spine/contract_check.js']));
  checks.push(runCmd('schema_contract_check', 'node', ['systems/security/schema_contract_check.js', 'run']));
  checks.push(runCmd('adaptive_layer_guard_strict', 'node', ['systems/sensory/adaptive_layer_guard.js', 'run', '--strict']));
  if (!options.skipTests) {
    checks.push(runCmd('test_ci', 'npm', ['run', 'test:ci']));
  }
  const failed = checks.filter((c) => !c.ok);
  return {
    ok: failed.length === 0,
    ts: new Date().toISOString(),
    checks: checks.map((c) => ({
      name: c.name,
      ok: c.ok,
      status: c.status,
      command: c.command
    })),
    failed: failed.map((c) => ({
      name: c.name,
      status: c.status,
      stdout: c.stdout.split('\n').slice(0, 20).join('\n'),
      stderr: c.stderr.split('\n').slice(0, 20).join('\n')
    }))
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '');
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd !== 'run') {
    usage();
    process.exit(2);
  }

  const out = runGuard({ skipTests: args['skip-tests'] === true });
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  if (!out.ok) process.exit(1);
}

if (require.main === module) {
  main();
}

module.exports = {
  runGuard
};
export {};
