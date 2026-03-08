#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const script = path.join(ROOT, 'systems/ops/system_map_generator.js');
const mapPath = path.join(ROOT, 'docs/architecture/SYSTEM_MAP.md');

function run(args = []) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: process.env
  });
}

function parseJson(stdout) {
  const txt = String(stdout || '').trim();
  return txt ? JSON.parse(txt) : {};
}

function main() {
  const res = run(['run', '--apply=1']);
  assert.strictEqual(res.status, 0, res.stderr);
  const payload = parseJson(res.stdout);
  assert.strictEqual(payload.ok, true);
  assert.ok(Number(payload.entry_count || 0) >= 10);
  assert.ok(fs.existsSync(mapPath), 'system map markdown missing');
  const md = fs.readFileSync(mapPath, 'utf8');
  assert.ok(md.includes('# System Map'));
  assert.ok(md.includes('Persistent Cockpit Daemon'));
  assert.ok(md.includes('Global Importance Kernel'));
  assert.ok(md.includes('V6-INITIATIVE-013'));
  console.log('system_map_generator.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`system_map_generator.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
