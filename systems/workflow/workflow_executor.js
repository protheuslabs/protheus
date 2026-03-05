#!/usr/bin/env node
'use strict';
Object.defineProperty(exports, "__esModule", { value: true });

const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const LANE = 'workflow_executor';

function runRust(args = []) {
  const cargoArgs = [
    'run',
    '--quiet',
    '--manifest-path',
    'crates/ops/Cargo.toml',
    '--bin',
    'protheus-ops',
    '--',
    'workflow-executor',
    ...args
  ];
  const run = spawnSync('cargo', cargoArgs, {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      PROTHEUS_NODE_BINARY: process.execPath || 'node'
    }
  });

  const status = Number.isFinite(run.status) ? run.status : 1;
  const stdout = run.stdout || '';
  const stderr = run.stderr || '';
  let payload = null;
  const lines = stdout.trim().split(/\n+/).reverse();
  for (const line of lines) {
    if (!line || line[0] !== '{') continue;
    try {
      payload = JSON.parse(line);
      break;
    } catch (_) {}
  }

  return { ok: status === 0, status, stdout, stderr, payload };
}

function runRustCli() {
  const out = runRust(process.argv.slice(2));
  if (out.stdout) process.stdout.write(out.stdout);
  if (out.stderr) process.stderr.write(out.stderr);
  process.exit(out.status);
}

if (require.main === module) {
  runRustCli();
}

module.exports = {
  lane: LANE,
  run: runRust
};
