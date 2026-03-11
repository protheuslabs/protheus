#!/usr/bin/env node
'use strict';

const { execSync } = require('child_process');

const REPO_ROOT = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();

const CODE_EXT_RE = /\.(rs|ts|js|py|c|cc|cpp|h|hpp|html|css|sh|ps1)$/;
const CORE_DISALLOWED_RE = /\.(ts|js|py|sh|ps1|html|css)$/;
const CLIENT_NATIVE_RE = /\.(rs|c|cc|cpp|h|hpp)$/;
const EXEMPT_CODE_ROOTS = new Set([
  'adapters',
  'apps',
  'benchmarks',
  'docs',
  'deploy',
  'examples',
  'packages',
  'scripts',
  'tests'
]);

function loadTrackedFiles() {
  const out = execSync('git ls-files', {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  });
  return out.split('\n').map((v) => v.trim()).filter(Boolean);
}

function firstSegment(relPath) {
  const idx = relPath.indexOf('/');
  if (idx < 0) return relPath;
  return relPath.slice(0, idx);
}

function printViolation(title, rows) {
  if (!rows || rows.length === 0) return;
  console.log('');
  console.log(`LAYER RULE VIOLATION: ${title}`);
  for (const row of rows) console.log(row);
}

function main() {
  const files = loadTrackedFiles();
  let fail = false;

  const badRoots = files
    .filter((p) => CODE_EXT_RE.test(p))
    .filter((p) => p.includes('/'))
    .filter((p) => {
      const seg = firstSegment(p);
      if (seg === 'core' || seg === 'client') return false;
      if (seg.startsWith('.')) return false;
      return !EXEMPT_CODE_ROOTS.has(seg);
    })
    .sort();
  if (badRoots.length > 0) {
    fail = true;
    printViolation('source code paths outside /core or /client', badRoots);
  }

  const coreDisallowed = files
    .filter((p) => p.startsWith('core/'))
    .filter((p) => CORE_DISALLOWED_RE.test(p))
    .sort();
  if (coreDisallowed.length > 0) {
    fail = true;
    printViolation('non-core language files in /core', coreDisallowed);
  }

  const clientNative = files
    .filter((p) => p.startsWith('client/'))
    .filter((p) => CLIENT_NATIVE_RE.test(p))
    .sort();
  if (clientNative.length > 0) {
    fail = true;
    printViolation('Rust/C/C++ files in /client', clientNative);
  }

  if (fail) {
    process.exit(1);
  }

  console.log('Layer rulebook checks passed.');
}

main();
