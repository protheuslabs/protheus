#!/usr/bin/env node
'use strict';

/**
 * integrity_kernel.js
 *
 * Tamper-evident integrity kernel for security-critical files.
 *
 * Usage:
 *   node systems/security/integrity_kernel.js run [--policy=/abs/path.json]
 *   node systems/security/integrity_kernel.js status [--policy=/abs/path.json]
 *   node systems/security/integrity_kernel.js seal [--policy=/abs/path.json] --approval-note="..."
 *   node systems/security/integrity_kernel.js --help
 */

const path = require('path');
const {
  DEFAULT_POLICY_PATH,
  verifyIntegrity,
  sealIntegrity
} = require('../../lib/security_integrity');

function usage() {
  console.log('Usage:');
  console.log('  node systems/security/integrity_kernel.js run [--policy=/abs/path.json]');
  console.log('  node systems/security/integrity_kernel.js status [--policy=/abs/path.json]');
  console.log('  node systems/security/integrity_kernel.js seal [--policy=/abs/path.json] --approval-note="..."');
  console.log('  node systems/security/integrity_kernel.js --help');
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

function cmdRun(policyPath) {
  const result = verifyIntegrity(policyPath);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (!result.ok) process.exit(1);
}

function cmdSeal(policyPath, note) {
  const approvalNote = String(note || '').trim();
  if (approvalNote.length < 10) {
    process.stdout.write(JSON.stringify({
      ok: false,
      error: 'approval_note_too_short',
      min_len: 10
    }) + '\n');
    process.exit(2);
  }
  const result = sealIntegrity(policyPath, {
    approval_note: approvalNote,
    sealed_by: process.env.USER || 'unknown'
  });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim();
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help' || args.help) {
    usage();
    process.exit(0);
  }
  const policyPath = path.resolve(String(args.policy || DEFAULT_POLICY_PATH));

  if (cmd === 'run' || cmd === 'status') {
    cmdRun(policyPath);
    return;
  }
  if (cmd === 'seal') {
    cmdSeal(policyPath, args['approval-note'] || args.approval_note);
    return;
  }
  usage();
  process.exit(2);
}

if (require.main === module) {
  main();
}
export {};
