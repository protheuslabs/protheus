#!/usr/bin/env node
'use strict';

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

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

function resolveEngineInvocation(cwd) {
  const engineJs = path.join(cwd, 'client', 'systems', 'security', 'formal_invariant_engine.js');
  if (hasFile(engineJs)) {
    return [engineJs];
  }
  const engineTs = path.join(cwd, 'client', 'systems', 'security', 'formal_invariant_engine.ts');
  const tsEntrypoint = path.join(cwd, 'client', 'lib', 'ts_entrypoint.js');
  if (hasFile(engineTs) && hasFile(tsEntrypoint)) {
    return [tsEntrypoint, engineTs];
  }
  return [engineJs];
}

function hasFile(filePath) {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
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

  const invocation = resolveEngineInvocation(cwd);
  const status = run(process.execPath, [...invocation, ...engineArgs], cwd);
  process.exit(status);
}

main();
