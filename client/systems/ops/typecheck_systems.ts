#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function resolveRepoRoot(startDir) {
  let dir = path.resolve(startDir);
  while (true) {
    const pkg = path.join(dir, 'package.json');
    const cargo = path.join(dir, 'Cargo.toml');
    const coreDir = path.join(dir, 'core');
    const clientDir = path.join(dir, 'client');
    if (fs.existsSync(pkg) && (fs.existsSync(cargo) || fs.existsSync(coreDir) || fs.existsSync(clientDir))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(__dirname, '..', '..');
    dir = parent;
  }
}

function resolveProjectPath(root) {
  const candidates = [
    path.join(root, 'tsconfig.systems.json'),
    path.join(root, 'client', 'tsconfig.systems.json')
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return candidates[0];
}

function resolveLocalTsc(root) {
  const bin = process.platform === 'win32' ? 'tsc.cmd' : 'tsc';
  const candidates = [
    path.join(root, 'node_modules', '.bin', bin),
    path.join(root, 'client', 'node_modules', '.bin', bin)
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return candidates[0];
}

const ROOT = resolveRepoRoot(__dirname);
const PROJECT_PATH = resolveProjectPath(ROOT);
const LOCAL_TSC = resolveLocalTsc(ROOT);

function run(bin, args) {
  return spawnSync(bin, args, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: false
  });
}

function main() {
  const args = ['-p', PROJECT_PATH];
  if (fs.existsSync(LOCAL_TSC)) {
    const r = run(LOCAL_TSC, args);
    process.exit(typeof r.status === 'number' ? r.status : 1);
  }

  const r = run('tsc', args);
  if (r.error && r.error.code === 'ENOENT') {
    process.stderr.write('typecheck:systems requires TypeScript. Install with `npm install --save-dev typescript`.\n');
    process.exit(2);
  }
  process.exit(typeof r.status === 'number' ? r.status : 1);
}

if (require.main === module) {
  main();
}
export {};
