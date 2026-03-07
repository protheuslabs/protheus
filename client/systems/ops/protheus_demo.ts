#!/usr/bin/env node
'use strict';
export {};

const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = process.env.OPENCLAW_WORKSPACE
  ? path.resolve(process.env.OPENCLAW_WORKSPACE)
  : path.resolve(__dirname, '..', '..');
const PROTHEUS_BIN = path.join(ROOT, 'bin', 'protheus');

function cleanText(v: unknown, maxLen = 400) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function toBool(v: unknown, fallback = false) {
  const raw = cleanText(v, 20).toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function parseArgs(argv: string[]) {
  const out: Record<string, any> = { _: [] };
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
  console.log('  protheus demo');
  console.log('  protheus demo --json=1');
}

function runStep(args: string[]) {
  const run = spawnSync(PROTHEUS_BIN, args, {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      PROTHEUS_SKIP_SETUP: '1',
      PROTHEUS_CLI_SUGGESTIONS: '0',
      PROTHEUS_GLOBAL_QUIET: process.env.PROTHEUS_GLOBAL_QUIET || '0'
    }
  });

  return {
    args,
    status: Number.isFinite(run.status) ? Number(run.status) : 1,
    stdout_preview: cleanText(run.stdout, 420),
    stderr_preview: cleanText(run.stderr, 420)
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const first = cleanText(args._[0] || '', 40).toLowerCase();
  if (args.help || first === 'help' || first === '--help' || first === '-h') {
    usage();
    process.exit(0);
  }

  const steps = [
    ['list'],
    ['version'],
    ['examples', 'research'],
    ['setup', 'status', '--json=1']
  ];

  const results = steps.map((step) => runStep(step));
  const payload = {
    ok: results.every((row) => row.status === 0),
    type: 'protheus_demo',
    ts: new Date().toISOString(),
    steps: results
  };

  if (toBool(args.json ?? process.env.PROTHEUS_GLOBAL_JSON, false)) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    process.exit(payload.ok ? 0 : 1);
  }

  process.stdout.write('Protheus Demo\n\n');
  for (const row of results) {
    process.stdout.write(`$ protheus ${row.args.join(' ')}\n`);
    if (row.stdout_preview) process.stdout.write(`${row.stdout_preview}\n`);
    if (row.stderr_preview) process.stdout.write(`[stderr] ${row.stderr_preview}\n`);
    process.stdout.write('\n');
  }

  process.stdout.write(payload.ok ? 'Demo complete.\n' : 'Demo completed with failures.\n');
  process.exit(payload.ok ? 0 : 1);
}

if (require.main === module) {
  main();
}
