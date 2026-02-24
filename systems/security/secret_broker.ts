#!/usr/bin/env node
'use strict';

const {
  issueSecretHandle,
  resolveSecretHandle
} = require('../../lib/secret_broker');

function usage() {
  console.log('Usage:');
  console.log('  node systems/security/secret_broker.js issue --secret-id=<id> --scope=<scope> [--caller=<caller>] [--ttl-sec=N] [--reason=...]');
  console.log('  node systems/security/secret_broker.js resolve --handle=<token> [--scope=<scope>] [--caller=<caller>] [--reveal=1]');
  console.log('  node systems/security/secret_broker.js --help');
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

function printJson(obj, exitCode = 0) {
  process.stdout.write(JSON.stringify(obj) + '\n');
  process.exit(exitCode);
}

function cmdIssue(args) {
  const res = issueSecretHandle({
    secret_id: args['secret-id'] || args.secret_id,
    scope: args.scope,
    caller: args.caller,
    ttl_sec: args['ttl-sec'] || args.ttl_sec,
    reason: args.reason
  });
  printJson(res, res.ok ? 0 : 1);
}

function cmdResolve(args) {
  const reveal = String(args.reveal || args['show-value'] || '0') === '1';
  const res = resolveSecretHandle(args.handle, {
    scope: args.scope,
    caller: args.caller
  });
  if (!res.ok) printJson(res, 1);
  if (reveal) {
    printJson(res, 0);
    return;
  }
  const masked = {
    ...res,
    value: res.value ? `[redacted:${String(res.value_hash || '').slice(0, 16)}]` : null
  };
  printJson(masked, 0);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim();
  if (!cmd || cmd === 'help' || args.help || cmd === '--help' || cmd === '-h') {
    usage();
    process.exit(0);
  }
  if (cmd === 'issue') return cmdIssue(args);
  if (cmd === 'resolve') return cmdResolve(args);
  usage();
  process.exit(2);
}

if (require.main === module) {
  main();
}
export {};
