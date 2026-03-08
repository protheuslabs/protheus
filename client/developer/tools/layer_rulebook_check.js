#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const REPO_ROOT = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();

const CODE_EXT_RE = /\.(rs|ts|js|py|c|cc|cpp|h|hpp|html|css|sh|ps1)$/;
const CORE_DISALLOWED_RE = /\.(ts|js|py|sh|ps1|html|css)$/;
const CLIENT_NATIVE_RE = /\.(rs|c|cc|cpp|h|hpp)$/;

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

function isThinBootstrapShim(source) {
  const rawLines = String(source || '').split(/\r?\n/);
  let lines = rawLines;
  if (lines.length > 0 && lines[0].startsWith('#!')) {
    lines = lines.slice(1);
  }

  let seenBootstrap = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line === "'use strict';" || line === '"use strict";') continue;
    if (/ts_bootstrap/.test(line) && /\.bootstrap\(__filename,\s*module\);?$/.test(line)) {
      seenBootstrap = true;
      continue;
    }
    return false;
  }
  return seenBootstrap;
}

function printViolation(title, rows) {
  if (!rows || rows.length === 0) return;
  console.log('');
  console.log(`LAYER RULE VIOLATION: ${title}`);
  for (const row of rows) console.log(row);
}

function main() {
  const files = loadTrackedFiles();
  const fileSet = new Set(files);
  let fail = false;

  const badRoots = files
    .filter((p) => CODE_EXT_RE.test(p))
    .filter((p) => p.includes('/'))
    .filter((p) => {
      const seg = firstSegment(p);
      return seg !== 'core' && seg !== 'client' && !seg.startsWith('.');
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

  const tsJsPairViolations = [];
  for (const jsPath of files) {
    if (!jsPath.endsWith('.js')) continue;
    const tsPath = jsPath.slice(0, -3) + '.ts';
    if (!fileSet.has(tsPath)) continue;
    const absJs = path.join(REPO_ROOT, jsPath);
    let source = '';
    try {
      source = fs.readFileSync(absJs, 'utf8');
    } catch {
      tsJsPairViolations.push(jsPath);
      continue;
    }
    if (!isThinBootstrapShim(source)) {
      tsJsPairViolations.push(jsPath);
    }
  }

  if (tsJsPairViolations.length > 0) {
    fail = true;
    printViolation('JS/TS duplicate pairs with non-thin JS logic', tsJsPairViolations.sort());
  }

  if (fail) {
    process.exit(1);
  }

  console.log('Layer rulebook checks passed.');
}

main();
