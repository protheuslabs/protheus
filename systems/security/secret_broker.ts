#!/usr/bin/env node
'use strict';

const {
  issueSecretHandle,
  resolveSecretHandle,
  evaluateSecretRotationHealth,
  secretBrokerStatus
} = require('../../lib/secret_broker');

function usage() {
  console.log('Usage:');
  console.log('  node systems/security/secret_broker.js issue --secret-id=<id> --scope=<scope> [--caller=<caller>] [--ttl-sec=N] [--reason=...] [--policy=/abs/path.json]');
  console.log('  node systems/security/secret_broker.js resolve --handle=<token> [--scope=<scope>] [--caller=<caller>] [--reveal=1] [--policy=/abs/path.json]');
  console.log('  node systems/security/secret_broker.js rotation-check [--secret-ids=id1,id2] [--policy=/abs/path.json] [--strict=1]');
  console.log('  node systems/security/secret_broker.js status [--policy=/abs/path.json]');
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

function parseSecretIds(raw) {
  return String(raw == null ? '' : raw)
    .split(',')
    .map((x) => String(x || '').trim())
    .filter(Boolean);
}

function cmdIssue(args) {
  const res = issueSecretHandle({
    secret_id: args['secret-id'] || args.secret_id,
    scope: args.scope,
    caller: args.caller,
    ttl_sec: args['ttl-sec'] || args.ttl_sec,
    reason: args.reason,
    policy_path: args.policy
  });
  printJson(res, res.ok ? 0 : 1);
}

function cmdResolve(args) {
  const reveal = String(args.reveal || args['show-value'] || '0') === '1';
  const res = resolveSecretHandle(args.handle, {
    scope: args.scope,
    caller: args.caller,
    policy_path: args.policy
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

function cmdRotationCheck(args) {
  const strict = String(args.strict || '0') === '1';
  const res = evaluateSecretRotationHealth({
    secret_ids: parseSecretIds(args['secret-ids'] || args.secret_ids),
    policy_path: args.policy
  });
  printJson(res, res.ok || !strict ? 0 : 1);
}

function cmdStatus(args) {
  const res = secretBrokerStatus({
    policy_path: args.policy
  });
  printJson(res, res.ok ? 0 : 1);
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
  if (cmd === 'rotation-check') return cmdRotationCheck(args);
  if (cmd === 'status') return cmdStatus(args);
  usage();
  process.exit(2);
}

if (require.main === module) {
  main();
}
export {};
