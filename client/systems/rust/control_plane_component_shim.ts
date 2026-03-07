#!/usr/bin/env node
'use strict';
export {};

/**
 * Rust component shim for control-plane cutover harness.
 * Provides deterministic probe envelopes for parity/route checks.
 */

const { nowIso, parseArgs, normalizeToken, emit } = require('../../lib/queued_backlog_runtime');

function usage() {
  console.log('Usage:');
  console.log('  node systems/rust/control_plane_component_shim.js run --component=<id> [--engine=rust|js]');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || 'run', 40) || 'run';
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    usage();
    return;
  }
  if (cmd !== 'run') emit({ ok: false, error: 'unsupported_command', cmd }, 1);

  const component = normalizeToken(args.component || '', 80);
  if (!component) emit({ ok: false, error: 'component_required' }, 1);
  const engine = normalizeToken(args.engine || 'rust', 16) || 'rust';

  emit({
    ok: true,
    type: 'control_plane_component_probe',
    ts: nowIso(),
    component,
    engine: engine === 'js' ? 'js' : 'rust',
    contract_version: '1.0',
    health: 'green'
  });
}

main();
