#!/usr/bin/env node
'use strict';
export {};

/**
 * CLI bridge for: protheusctl skills discover --mcp
 */

const path = require('path');
const { spawnSync } = require('child_process');

function usage() {
  console.log('Usage: protheusctl skills discover --mcp [--query=<keyword>]');
}

function parseArgs(argv: string[]) {
  const out: Record<string, any> = { _: [] };
  for (const tok of argv) {
    if (!tok.startsWith('--')) {
      out._.push(tok);
      continue;
    }
    const eq = tok.indexOf('=');
    if (eq >= 0) out[tok.slice(2, eq)] = tok.slice(eq + 1);
    else out[tok.slice(2)] = true;
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    usage();
    process.exit(0);
  }
  if (args.mcp !== true && args.mcp !== '1' && args.mcp !== 'true') {
    usage();
    process.stdout.write(JSON.stringify({
      ok: false,
      error: 'mcp_flag_required',
      expected: 'protheusctl skills discover --mcp'
    }, null, 2) + '\n');
    process.exit(2);
  }
  const gateway = path.join(__dirname, '..', '..', 'skills', 'mcp', 'mcp_gateway.js');
  const params = ['discover'];
  if (args.query) params.push(`--query=${String(args.query)}`);
  const proc = spawnSync('node', [gateway, ...params], {
    cwd: path.join(__dirname, '..', '..'),
    encoding: 'utf8'
  });
  if (proc.stdout) process.stdout.write(proc.stdout);
  if (proc.stderr) process.stderr.write(proc.stderr);
  process.exit(Number.isFinite(proc.status) ? proc.status : 1);
}

main();
