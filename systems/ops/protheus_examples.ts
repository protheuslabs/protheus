#!/usr/bin/env node
'use strict';
export {};

const { buildManifest } = require('./protheus_command_list.js');

type AnyObj = Record<string, any>;

function cleanText(v: unknown, maxLen = 400) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeToken(v: unknown, maxLen = 120) {
  return cleanText(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.:/-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function toBool(v: unknown, fallback = false) {
  const raw = cleanText(v, 20).toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const tok = String(argv[i] || '');
    if (!tok.startsWith('--')) {
      out._.push(tok);
      continue;
    }
    const idx = tok.indexOf('=');
    if (idx >= 0) {
      out[tok.slice(2, idx)] = tok.slice(idx + 1);
      continue;
    }
    const key = tok.slice(2);
    const next = argv[i + 1];
    if (next != null && !String(next).startsWith('--')) {
      out[key] = String(next);
      i += 1;
      continue;
    }
    out[key] = true;
  }
  return out;
}

function usage() {
  console.log('Usage:');
  console.log('  protheus examples');
  console.log('  protheus examples <command>');
  console.log('  protheus examples --command=<command> [--json=1]');
}

function manifestRows() {
  const manifest = buildManifest();
  return (manifest.categories || [])
    .flatMap((category: AnyObj) => (category.commands || []).map((row: AnyObj) => ({
      category: cleanText(category.label, 80),
      command: cleanText(row.command, 120),
      usage: cleanText(row.usage, 260),
      summary: cleanText(row.summary, 280)
    })))
    .filter((row: AnyObj) => row.command && row.usage);
}

function pick(rows: AnyObj[], command: string) {
  const wanted = normalizeToken(command, 120);
  if (!wanted) return rows;
  return rows.filter((row) => normalizeToken(row.command, 120) === wanted);
}

function render(rows: AnyObj[]) {
  const lines: string[] = [];
  lines.push('Protheus Examples');
  lines.push('');
  for (const row of rows) {
    lines.push(`- ${row.usage}`);
    lines.push(`  ${row.summary}`);
  }
  if (!rows.length) {
    lines.push('- No matching command examples found. Try `protheus list`.');
  }
  return lines.join('\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const first = normalizeToken(args._[0] || '', 80);
  if (args.help || first === 'help' || first === '--help' || first === '-h') {
    usage();
    process.exit(0);
  }

  const command = cleanText(args.command || args._[0] || '', 120);
  const rows = pick(manifestRows(), command);
  const payload = {
    ok: true,
    type: 'protheus_examples',
    command: command || null,
    count: rows.length,
    examples: rows
  };

  if (toBool(args.json ?? process.env.PROTHEUS_GLOBAL_JSON, false)) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${render(rows)}\n`);
}

if (require.main === module) {
  main();
}

module.exports = {
  manifestRows,
  pick
};
