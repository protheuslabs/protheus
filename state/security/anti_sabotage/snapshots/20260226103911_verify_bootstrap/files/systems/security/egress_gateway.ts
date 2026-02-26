#!/usr/bin/env node
'use strict';

const {
  DEFAULT_POLICY_PATH,
  DEFAULT_STATE_PATH,
  loadPolicy,
  loadState,
  authorizeEgress
} = require('../../lib/egress_gateway');

function usage() {
  console.log('Usage:');
  console.log('  node systems/security/egress_gateway.js authorize --scope=<scope> --url=<url> [--method=GET] [--caller=<caller>] [--runtime-allowlist=d1,d2] [--apply=0|1]');
  console.log('  node systems/security/egress_gateway.js status [--policy=/abs/path.json] [--state=/abs/path.json]');
  console.log('  node systems/security/egress_gateway.js --help');
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

function asList(v) {
  if (Array.isArray(v)) return v.map((x) => String(x || '').trim()).filter(Boolean);
  return String(v == null ? '' : v)
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

function printJson(obj, code = 0) {
  process.stdout.write(JSON.stringify(obj) + '\n');
  process.exit(code);
}

function cmdAuthorize(args) {
  const apply = String(args.apply == null ? '1' : args.apply) !== '0';
  const res = authorizeEgress({
    scope: args.scope,
    caller: args.caller,
    method: args.method || 'GET',
    url: args.url,
    apply,
    runtime_allowlist: asList(args['runtime-allowlist'] || args.runtime_allowlist),
    policy_path: args.policy,
    state_path: args.state,
    audit_path: args.audit
  });
  printJson(res, res.allow ? 0 : 1);
}

function cmdStatus(args) {
  const policyPath = args.policy || DEFAULT_POLICY_PATH;
  const statePath = args.state || DEFAULT_STATE_PATH;
  const policy = loadPolicy(policyPath);
  const state = loadState(statePath);
  printJson({
    ok: true,
    policy_path: policyPath,
    state_path: statePath,
    policy,
    state
  }, 0);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim();
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'authorize') return cmdAuthorize(args);
  if (cmd === 'status') return cmdStatus(args);
  usage();
  process.exit(2);
}

if (require.main === module) {
  main();
}
export {};
