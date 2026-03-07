#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const PROJECT_PATH = path.join(ROOT, 'tsconfig.systems.build.json');
const DIST_PATH = path.join(ROOT, 'dist');
const LOCAL_TSC = path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');

function run(bin, args) {
  return spawnSync(bin, args, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: false
  });
}

function main() {
  if (fs.existsSync(DIST_PATH)) {
    fs.rmSync(DIST_PATH, { recursive: true, force: true });
  }

  const args = ['-p', PROJECT_PATH];
  if (fs.existsSync(LOCAL_TSC)) {
    const r = run(LOCAL_TSC, args);
    process.exit(typeof r.status === 'number' ? r.status : 1);
  }

  const r = run('tsc', args);
  if (r.error && r.error.code === 'ENOENT') {
    process.stderr.write('build:systems requires TypeScript. Install with `npm install --save-dev typescript`.\n');
    process.exit(2);
  }
  process.exit(typeof r.status === 'number' ? r.status : 1);
}

if (require.main === module) {
  main();
}
