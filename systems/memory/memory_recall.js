#!/usr/bin/env node
'use strict';

const memorySurface = require('./index.js');

function remapArgs(argv) {
  const args = Array.isArray(argv) ? argv.slice(0) : [];
  if (!args.length) return ['help'];

  const cmd = String(args[0] || '').trim().toLowerCase();
  const rest = args.slice(1);

  if (cmd === 'query') {
    const mapped = rest.map((token) => {
      const raw = String(token || '');
      if (raw.startsWith('--q=')) return `--query=${raw.slice('--q='.length)}`;
      if (raw === '--q') return '--query';
      if (raw.startsWith('--top=')) return `--limit=${raw.slice('--top='.length)}`;
      if (raw === '--top') return '--limit';
      return raw;
    });
    return ['recall', ...mapped];
  }

  if (cmd === 'status') {
    return ['probe', ...rest];
  }

  return [cmd, ...rest];
}

function run(args = []) {
  const mapped = remapArgs(args);
  const command = String(mapped[0] || 'help');
  const rest = mapped.slice(1);
  return memorySurface.runMemoryCli(command, rest, 180000, {
    run_context: 'memory_recall_surface',
    ambient_mode: true
  });
}

function runCli(args = []) {
  const out = run(args);
  if (out && out.payload) {
    process.stdout.write(`${JSON.stringify(out.payload)}\n`);
  } else if (out && out.ambient_receipt) {
    process.stdout.write(`${JSON.stringify(out.ambient_receipt)}\n`);
  }
  if (out && out.stderr) {
    process.stderr.write(String(out.stderr));
    if (!String(out.stderr).endsWith('\n')) process.stderr.write('\n');
  }
  const status = Number.isFinite(Number(out && out.status))
    ? Number(out.status)
    : (out && out.ok ? 0 : 1);
  process.exit(status);
}

if (require.main === module) {
  runCli(process.argv.slice(2));
}

module.exports = {
  run
};
