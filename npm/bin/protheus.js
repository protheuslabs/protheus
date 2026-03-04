#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function isFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function resolveExecutableName() {
  return process.platform === 'win32' ? 'protheus-ops.exe' : 'protheus-ops';
}

function findBinary() {
  const exe = resolveExecutableName();
  const pkgRoot = path.resolve(__dirname, '..');
  const vendorPath = path.join(pkgRoot, 'vendor', exe);
  if (isFile(vendorPath)) return vendorPath;

  const envPath = String(process.env.PROTHEUS_NPM_BINARY || '').trim();
  if (envPath && isFile(envPath)) return envPath;
  return null;
}

function hasRuntimeAssets(rootDir) {
  if (!rootDir) return false;
  return isFile(path.join(rootDir, 'systems', 'ops', 'protheusctl.js'));
}

function resolveRuntimeRoot(pkgRoot) {
  const explicit = String(process.env.PROTHEUS_ROOT || '').trim();
  if (explicit && hasRuntimeAssets(explicit)) return explicit;

  const cwd = process.cwd();
  if (hasRuntimeAssets(cwd)) return cwd;

  const repoRootCandidate = path.resolve(pkgRoot, '..');
  if (hasRuntimeAssets(repoRootCandidate)) return repoRootCandidate;

  const bundled = path.join(pkgRoot, 'runtime');
  if (hasRuntimeAssets(bundled)) return bundled;

  return null;
}

function run() {
  const pkgRoot = path.resolve(__dirname, '..');
  const binPath = findBinary();
  if (!binPath) {
    process.stderr.write('protheus npm binary is missing. Reinstall package or run npm rebuild protheus.\n');
    process.exit(1);
  }

  const runtimeRoot = resolveRuntimeRoot(pkgRoot);
  const args = process.argv.slice(2);
  const env = { ...process.env };

  let finalArgs;
  if (runtimeRoot) {
    env.PROTHEUS_ROOT = runtimeRoot;
    finalArgs = ['protheusctl', ...args];
  } else {
    // Fallback for binary-only installations: route directly to protheus-ops domains.
    // Also disable dispatch security gate because source-only security lane is unavailable.
    env.PROTHEUS_CTL_SECURITY_GATE_DISABLED = '1';
    finalArgs = args.length ? args : ['--help'];
  }

  const out = spawnSync(binPath, finalArgs, {
    stdio: 'inherit',
    env,
    cwd: runtimeRoot || process.cwd()
  });
  process.exit(Number.isFinite(out.status) ? out.status : 1);
}

run();
