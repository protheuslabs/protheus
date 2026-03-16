#!/usr/bin/env node
'use strict';

// Layer ownership: client/runtime/systems/ops (authoritative app bridge helper)

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');

function isFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function resolveBinary() {
  const explicit = String(process.env.PROTHEUS_NPM_BINARY || '').trim();
  if (explicit && isFile(explicit)) return explicit;

  const release = path.join(
    ROOT,
    'target',
    'release',
    process.platform === 'win32' ? 'protheus-ops.exe' : 'protheus-ops'
  );
  if (isFile(release)) return release;

  const target = path.join(
    ROOT,
    'target',
    'debug',
    process.platform === 'win32' ? 'protheus-ops.exe' : 'protheus-ops'
  );
  if (isFile(target)) return target;

  const vendor = path.join(
    ROOT,
    'client',
    'cli',
    'npm',
    'vendor',
    process.platform === 'win32' ? 'protheus-ops.exe' : 'protheus-ops'
  );
  if (isFile(vendor)) return vendor;

  return null;
}

function runProtheusOps(args, options = {}) {
  const bin = resolveBinary();
  const env = { ...process.env, PROTHEUS_ROOT: ROOT, ...(options.env || {}) };
  const proc = bin
    ? spawnSync(bin, args, {
        cwd: ROOT,
        encoding: 'utf8',
        stdio: 'inherit',
        env,
      })
    : spawnSync(
        'cargo',
        ['run', '--quiet', '-p', 'protheus-ops-core', '--bin', 'protheus-ops', '--'].concat(args),
        {
          cwd: ROOT,
          encoding: 'utf8',
          stdio: 'inherit',
          env,
        }
      );
  return Number.isFinite(proc.status) ? proc.status : 1;
}

module.exports = { ROOT, resolveBinary, runProtheusOps };

if (require.main === module) {
  const exitCode = runProtheusOps(process.argv.slice(2));
  process.exit(exitCode);
}
