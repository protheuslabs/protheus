#!/usr/bin/env node
'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

function hasTypescript(cwd) {
  try {
    require.resolve('typescript', { paths: [cwd] });
    return true;
  } catch (_err) {
    return false;
  }
}

function run(cmd, args, cwd) {
  const result = spawnSync(cmd, args, { cwd, stdio: 'inherit' });
  if (result.error) {
    console.error(`formal_invariants_bootstrap:spawn_failed:${cmd}:${result.error.message}`);
    return 1;
  }
  if (typeof result.status === 'number') {
    return result.status;
  }
  return 1;
}

function main() {
  const cwd = process.cwd();
  const argv = process.argv.slice(2);
  const ensureOnly = argv.includes('--ensure-only');

  if (!hasTypescript(cwd)) {
    const installStatus = run('npm', ['install', '--no-save', 'typescript'], cwd);
    if (installStatus !== 0) {
      process.exit(installStatus);
    }
  }

  if (ensureOnly) {
    process.exit(0);
  }

  let engineArgs = argv.filter((arg) => arg !== '--ensure-only');
  if (engineArgs.length === 0) {
    engineArgs = ['run', '--strict=1'];
  }

  const enginePath = path.join('systems', 'security', 'formal_invariant_engine.js');
  const status = run(process.execPath, [enginePath, ...engineArgs], cwd);
  process.exit(status);
}

main();
