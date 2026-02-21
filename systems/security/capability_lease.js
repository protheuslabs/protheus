#!/usr/bin/env node
'use strict';

/**
 * capability_lease.js
 *
 * Issues/verifies single-use capability lease tokens for high-tier mutations.
 *
 * Usage:
 *   node systems/security/capability_lease.js issue --scope=<scope> [--target=<target>] [--ttl-sec=N] [--issued-by=<id>] [--reason=<text>]
 *   node systems/security/capability_lease.js verify --token=<token> [--scope=<scope>] [--target=<target>]
 *   node systems/security/capability_lease.js consume --token=<token> [--scope=<scope>] [--target=<target>] [--reason=<text>]
 *   node systems/security/capability_lease.js --help
 */

const { issueLease, verifyLease, LEASE_STATE_PATH, LEASE_AUDIT_PATH } = require('../../lib/capability_lease.js');

function usage() {
  console.log('Usage:');
  console.log('  node systems/security/capability_lease.js issue --scope=<scope> [--target=<target>] [--ttl-sec=N] [--issued-by=<id>] [--reason=<text>]');
  console.log('  node systems/security/capability_lease.js verify --token=<token> [--scope=<scope>] [--target=<target>]');
  console.log('  node systems/security/capability_lease.js consume --token=<token> [--scope=<scope>] [--target=<target>] [--reason=<text>]');
  console.log('  node systems/security/capability_lease.js --help');
}

function parseArgs(argv) {
  const out = { _: [] };
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

function fail(code, extra = {}) {
  process.stdout.write(JSON.stringify({ ok: false, error: code, ...extra }, null, 2) + '\n');
  process.exit(1);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim();
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || args.help) {
    usage();
    process.exit(0);
  }

  if (cmd === 'issue') {
    const scope = String(args.scope || '').trim();
    if (!scope) fail('scope_required');
    const out = issueLease({
      scope,
      target: args.target,
      ttl_sec: args['ttl-sec'] || args.ttl_sec,
      issued_by: args['issued-by'] || args.issued_by,
      reason: args.reason
    });
    if (!out.ok) fail(out.error || 'issue_failed', out);
    process.stdout.write(JSON.stringify({
      ok: true,
      ...out,
      lease_state_path: LEASE_STATE_PATH,
      lease_audit_path: LEASE_AUDIT_PATH
    }, null, 2) + '\n');
    return;
  }

  if (cmd === 'verify' || cmd === 'consume') {
    const token = String(args.token || '').trim();
    if (!token) fail('token_required');
    const out = verifyLease(token, {
      scope: args.scope,
      target: args.target,
      consume: cmd === 'consume',
      consume_reason: args.reason
    });
    if (!out.ok) fail(out.error || 'verify_failed', out);
    process.stdout.write(JSON.stringify({ ok: true, ...out }, null, 2) + '\n');
    return;
  }

  usage();
  process.exit(2);
}

if (require.main === module) {
  main();
}
