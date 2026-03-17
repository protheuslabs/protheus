#!/usr/bin/env node
'use strict';

// Thin client surface: command listing only. Authority remains in core/layer0/ops.

const COMMANDS = [
  { name: 'help', desc: 'Show CLI help and command list.' },
  { name: 'status', desc: 'Show daemon/control-plane status.' },
  { name: 'alpha-check', desc: 'Run alpha readiness checks.' },
  { name: 'session <status|register|resume|send|list>', desc: 'Manage command-center sessions.' },
  { name: 'orchestration', desc: 'Rust-core orchestration invoke surface (coordinator/scratchpad/checkpoint).' },
  { name: 'swarm-runtime', desc: 'Core swarm runtime lanes.' },
  { name: 'capability-profile', desc: 'Show hardware-sensed capability shedding profile.' },
  { name: 'autonomy:swarm:sessions:spawn', desc: 'Spawn a governed swarm session.' },
  { name: 'autonomy:swarm:sessions:send', desc: 'Send inter-agent message between sessions.' },
  { name: 'autonomy:swarm:sessions:receive', desc: 'Receive pending inter-agent messages.' },
  { name: 'autonomy:swarm:sessions:ack', desc: 'Acknowledge inter-agent message delivery.' },
  { name: 'autonomy:swarm:sessions:state', desc: 'Inspect session state/context/tool history.' },
  { name: 'autonomy:swarm:sessions:query', desc: 'Query swarm service discovery/result registry.' },
  { name: 'autonomy:swarm:sessions:tick', desc: 'Advance persistent swarm check-ins.' },
  { name: 'version', desc: 'Print runtime version and build info.' },
];

function parseArgs(argv) {
  const out = { mode: 'list', json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] || '');
    if (token.startsWith('--mode=')) out.mode = token.slice('--mode='.length).trim() || 'list';
    else if (token === '--mode' && argv[i + 1]) {
      out.mode = String(argv[i + 1] || '').trim() || 'list';
      i += 1;
    } else if (token === '--json' || token === '--json=1') out.json = true;
  }
  return out;
}

function printList() {
  process.stdout.write('InfRing command list:\n');
  for (const row of COMMANDS) {
    process.stdout.write(`  - ${row.name}\n`);
  }
}

function printHelp() {
  process.stdout.write('Usage: infring <command> [flags]\n\n');
  process.stdout.write('High-signal commands:\n');
  for (const row of COMMANDS) {
    process.stdout.write(`  ${row.name.padEnd(45, ' ')} ${row.desc}\n`);
  }
}

function run(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv);
  const mode = String(parsed.mode || 'list').toLowerCase();

  if (parsed.json) {
    process.stdout.write(
      `${JSON.stringify({ ok: true, type: 'infring_command_list', mode, commands: COMMANDS })}\n`
    );
    return 0;
  }

  if (mode === 'help') {
    printHelp();
    return 0;
  }

  printList();
  return 0;
}

if (require.main === module) {
  process.exit(run(process.argv.slice(2)));
}

module.exports = { run, COMMANDS };
