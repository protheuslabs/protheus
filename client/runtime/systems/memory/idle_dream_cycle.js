#!/usr/bin/env node
'use strict';

// Layer ownership: core/layer1/memory_runtime + core/layer0/ops::memory-ambient (authoritative)
const path = require('path');
const { spawnSync } = require('child_process');

const WORKSPACE_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

function usage() {
  console.log('Usage:');
  console.log('  node systems/memory/idle_dream_cycle.js run [YYYY-MM-DD] [--force=1] [--rem-only=1]');
  console.log('  node systems/memory/idle_dream_cycle.js status');
}

function parseJsonPayload(rawText) {
  const raw = String(rawText || '').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {}
  const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lines[i].startsWith('{')) continue;
    try {
      return JSON.parse(lines[i]);
    } catch {}
  }
  return null;
}

function resolveCoreIdleDreamCommand() {
  const explicit = String(process.env.PROTHEUS_IDLE_DREAM_BIN || '').trim();
  if (explicit) {
    return { command: explicit, args: [] };
  }

  const release = path.join(WORKSPACE_ROOT, 'target', 'release', 'idle_dream_cycle');
  if (require('fs').existsSync(release)) {
    return { command: release, args: [] };
  }
  const debug = path.join(WORKSPACE_ROOT, 'target', 'debug', 'idle_dream_cycle');
  if (require('fs').existsSync(debug)) {
    return { command: debug, args: [] };
  }

  return {
    command: 'cargo',
    args: [
      'run',
      '--quiet',
      '--manifest-path',
      'core/layer0/memory_runtime/Cargo.toml',
      '--bin',
      'idle_dream_cycle',
      '--'
    ]
  };
}

function runCore(args = []) {
  const resolved = resolveCoreIdleDreamCommand();
  const commandArgs = resolved.args.concat(Array.isArray(args) ? args : []);
  const run = spawnSync(resolved.command, commandArgs, {
    cwd: WORKSPACE_ROOT,
    encoding: 'utf8',
    timeout: Number(process.env.PROTHEUS_IDLE_DREAM_TIMEOUT_MS || 60000),
    env: process.env,
    maxBuffer: 1024 * 1024 * 4
  });
  return {
    ok: Number(run.status || 0) === 0,
    status: Number.isFinite(Number(run.status)) ? Number(run.status) : 1,
    payload: parseJsonPayload(run.stdout),
    stdout: String(run.stdout || ''),
    stderr: String(run.stderr || '')
  };
}

async function run(args = []) {
  const coreOut = runCore(args);
  if (!coreOut.payload) {
    coreOut.payload = {
      ok: false,
      type: 'idle_dream_cycle_wrapper_error',
      error: 'core_idle_dream_cycle_failed_no_payload'
    };
  }
  return coreOut;
}

if (require.main === module) {
  const raw = process.argv.slice(2);
  const token = String(raw[0] || '').trim().toLowerCase();
  if (token === 'help' || token === '--help' || token === '-h') {
    usage();
    process.exit(0);
  }
  process.env.PROTHEUS_CONDUIT_STARTUP_PROBE = '0';
  process.env.PROTHEUS_CONDUIT_COMPAT_FALLBACK = '0';
  process.env.PROTHEUS_CONDUIT_STARTUP_PROBE_TIMEOUT_MS =
    process.env.PROTHEUS_CONDUIT_STARTUP_PROBE_TIMEOUT_MS || '8000';
  run(raw)
    .then((out) => {
      if (out && out.payload) process.stdout.write(`${JSON.stringify(out.payload)}\n`);
      if (out && out.stderr) process.stderr.write(out.stderr.endsWith('\n') ? out.stderr : `${out.stderr}\n`);
      process.exit(Number.isFinite(out && out.status) ? Number(out.status) : 1);
    })
    .catch((error) => {
      process.stdout.write(
        `${JSON.stringify({
          ok: false,
          type: 'idle_dream_cycle_wrapper_error',
          error: String(error && error.message ? error.message : error)
        })}\n`
      );
      process.exit(1);
    });
}

module.exports = {
  run
};
