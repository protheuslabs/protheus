#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

function walk(dirPath, out = []) {
  if (!fs.existsSync(dirPath)) return out;
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const abs = path.join(dirPath, entry.name);
    if (entry.isDirectory()) walk(abs, out);
    else if (entry.isFile() && abs.endsWith('.js')) out.push(abs);
  }
  return out;
}

function run() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const roots = [
    path.join(repoRoot, 'systems', 'sensory'),
    path.join(repoRoot, 'skills', 'moltbook'),
    path.join(repoRoot, 'skills', 'moltstack')
  ];

  const allowDirect = new Set([
    path.join(repoRoot, 'lib', 'egress_gateway.js')
  ]);

  const offenders = [];
  const pattern = /\bfetch\s*\(|\bhttps\s*\.\s*(get|request)\s*\(/;

  for (const root of roots) {
    for (const abs of walk(root)) {
      if (allowDirect.has(abs)) continue;
      const rel = path.relative(repoRoot, abs).replace(/\\/g, '/');
      const src = fs.readFileSync(abs, 'utf8');
      if (pattern.test(src)) offenders.push(rel);
    }
  }

  assert.deepStrictEqual(offenders, [], `direct network calls detected outside egress gateway: ${offenders.join(', ')}`);
  console.log('egress_chokepoint_guard.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`egress_chokepoint_guard.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
