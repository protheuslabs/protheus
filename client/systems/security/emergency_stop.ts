#!/usr/bin/env node
'use strict';

/**
 * emergency_stop.js
 *
 * One-command kill-switch for autonomy/routing/actuation execution paths.
 *
 * Usage:
 *   node systems/security/emergency_stop.js status
 *   node systems/security/emergency_stop.js engage [--scope=all|autonomy|routing|actuation|spine[,..]] --approval-note="..."
 *   node systems/security/emergency_stop.js release --approval-note="..."
 *   node systems/security/emergency_stop.js --help
 */

const {
  VALID_SCOPES,
  getStopState,
  engageEmergencyStop,
  releaseEmergencyStop
} = require('../../lib/emergency_stop');

function usage() {
  console.log('Usage:');
  console.log('  node systems/security/emergency_stop.js status');
  console.log('  node systems/security/emergency_stop.js engage [--scope=all|autonomy|routing|actuation|spine[,..]] --approval-note="..."');
  console.log('  node systems/security/emergency_stop.js release --approval-note="..."');
  console.log('  node systems/security/emergency_stop.js --help');
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

function requireApprovalNote(note) {
  const s = String(note || '').trim();
  if (s.length >= 10) return s;
  process.stdout.write(JSON.stringify({
    ok: false,
    error: 'approval_note_too_short',
    min_len: 10
  }) + '\n');
  process.exit(2);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '');
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help' || args.help) {
    usage();
    process.exit(0);
  }

  if (cmd === 'status') {
    process.stdout.write(JSON.stringify({
      ok: true,
      ts: new Date().toISOString(),
      state: getStopState()
    }, null, 2) + '\n');
    return;
  }

  if (cmd === 'engage') {
    const note = requireApprovalNote(args['approval-note'] || args.approval_note);
    const scopeRaw = String(args.scope || 'all');
    const next = engageEmergencyStop({
      scopes: scopeRaw,
      approval_note: note,
      actor: args.actor,
      reason: args.reason
    });
    process.stdout.write(JSON.stringify({
      ok: true,
      result: 'engaged',
      ts: new Date().toISOString(),
      valid_scopes: Array.from(VALID_SCOPES),
      state: next
    }, null, 2) + '\n');
    return;
  }

  if (cmd === 'release') {
    const note = requireApprovalNote(args['approval-note'] || args.approval_note);
    const next = releaseEmergencyStop({
      approval_note: note,
      actor: args.actor,
      reason: args.reason
    });
    process.stdout.write(JSON.stringify({
      ok: true,
      result: 'released',
      ts: new Date().toISOString(),
      state: next
    }, null, 2) + '\n');
    return;
  }

  usage();
  process.exit(2);
}

if (require.main === module) {
  main();
}
export {};
