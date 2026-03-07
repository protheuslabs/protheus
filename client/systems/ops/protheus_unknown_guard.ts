#!/usr/bin/env node
'use strict';
export {};

const path = require('path');
const { spawnSync } = require('child_process');
const { buildManifest } = require('./protheus_command_list.js');
const { bestSuggestions, colorize, supportsColor } = require('./cli_ui.js');

const ROOT = path.resolve(__dirname, '..', '..');
const CONTROL_PLANE = path.join(ROOT, 'systems', 'ops', 'protheus_control_plane.js');

function cleanText(v: unknown, maxLen = 240) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function extractKnownCommands() {
  const manifest = buildManifest();
  const fromManifest = Array.from(new Set(
    (manifest.categories || [])
      .flatMap((category: any) => (category.commands || []).map((row: any) => String(row.command || '').trim()))
      .filter(Boolean)
  ));
  const passthrough = [
    'start',
    'stop',
    'restart',
    'top',
    'job-submit',
    'job-runner',
    'job-cancel',
    'incident',
    'release-promote',
    'release-rollback',
    'registry-install',
    'registry-uninstall',
    'registry-enable',
    'registry-disable',
    'registry-list',
    'auth-guard',
    'reseal-auto',
    'event-guard',
    'routing-reconcile',
    'deprecations-check',
    'backlog-validate',
    'backlog-allocate',
    'doctor-init',
    'doctor-bundle',
    'cli-contract',
    'warm-snapshot',
    'idle-governor',
    'audit'
  ];
  return Array.from(new Set([...fromManifest, ...passthrough]));
}

function printSuggestion(cmd: string, known: string[]) {
  const suggestions = bestSuggestions(cmd, known, 3);
  if (suggestions.length) {
    const header = supportsColor()
      ? colorize('warn', `Unknown command \`${cmd}\`.`)
      : `Unknown command \`${cmd}\`.`;
    process.stderr.write(`${header} Did you mean: ${suggestions.map((s: string) => `\`${s}\``).join(', ')}?\n`);
  } else if (cmd) {
    process.stderr.write(`Unknown command \`${cmd}\`.\n`);
  }
  process.stderr.write('Try `protheus list` to view all available commands.\n');
}

function main() {
  const argv = process.argv.slice(2);
  const cmd = cleanText(argv[0] || '', 120);
  const rest = argv.slice(1);
  const known = extractKnownCommands();
  if (cmd && !known.includes(cmd)) {
    printSuggestion(cmd, known);
    process.exit(2);
  }

  const run = spawnSync(process.execPath, [CONTROL_PLANE, cmd, ...rest], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  if (run.stdout) process.stdout.write(run.stdout);
  if (run.stderr) process.stderr.write(run.stderr);

  const status = Number.isFinite(run.status) ? Number(run.status) : 1;
  if (status === 0) process.exit(0);
  printSuggestion(cmd, known);
  process.exit(status);
}

if (require.main === module) {
  main();
}
