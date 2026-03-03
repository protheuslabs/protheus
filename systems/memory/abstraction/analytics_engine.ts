#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const MANIFEST = path.join(ROOT, 'crates', 'memory_abstraction', 'Cargo.toml');

function runCore(args: string[]) {
  const explicit = String(process.env.PROTHEUS_MEMORY_ABSTRACTION_BIN || '').trim();
  const candidates = [
    explicit,
    path.join(ROOT, 'target', 'release', 'memory_abstraction_core'),
    path.join(ROOT, 'target', 'debug', 'memory_abstraction_core'),
    path.join(ROOT, 'crates', 'memory_abstraction', 'target', 'release', 'memory_abstraction_core'),
    path.join(ROOT, 'crates', 'memory_abstraction', 'target', 'debug', 'memory_abstraction_core')
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (!candidate || !fs.existsSync(candidate)) continue;
    const out = spawnSync(candidate, args, {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024
    });
    if (out.stdout) process.stdout.write(String(out.stdout));
    if (out.stderr) process.stderr.write(String(out.stderr));
    process.exit(Number.isFinite(Number(out.status)) ? Number(out.status) : 1);
  }

  const out = spawnSync('cargo', [
    'run',
    '--quiet',
    '--manifest-path',
    MANIFEST,
    '--bin',
    'memory_abstraction_core',
    '--',
    ...args
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024
  });
  if (out.stdout) process.stdout.write(String(out.stdout));
  if (out.stderr) process.stderr.write(String(out.stderr));
  process.exit(Number.isFinite(Number(out.status)) ? Number(out.status) : 1);
}

const raw = process.argv.slice(2);
const cmd = raw.length ? raw[0] : 'status';
runCore(['analytics', cmd, ...raw.slice(1)]);

