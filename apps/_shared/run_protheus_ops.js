#!/usr/bin/env node
'use strict';

// App ownership: apps/_shared (public app contract helper)

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');

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

  const vendor = path.join(
    ROOT,
    'client',
    'cli',
    'npm',
    'vendor',
    process.platform === 'win32' ? 'protheus-ops.exe' : 'protheus-ops'
  );
  if (isFile(vendor)) return vendor;

  const target = path.join(
    ROOT,
    'target',
    'debug',
    process.platform === 'win32' ? 'protheus-ops.exe' : 'protheus-ops'
  );
  if (isFile(target)) return target;

  throw new Error('protheus-ops binary not found; set PROTHEUS_NPM_BINARY or build target/debug/protheus-ops');
}

function runProtheusOps(args, options = {}) {
  const bin = resolveBinary();
  const proc = spawnSync(bin, args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: 'inherit',
    env: { ...process.env, PROTHEUS_ROOT: ROOT, ...(options.env || {}) },
  });
  return Number.isFinite(proc.status) ? proc.status : 1;
}

module.exports = { ROOT, resolveBinary, runProtheusOps };
