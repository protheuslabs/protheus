#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const TOOL = path.join(ROOT, 'systems', 'ops', 'rust_hotpath_inventory.js');

function run(args) {
  const out = spawnSync(process.execPath, [TOOL, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      PROTHEUS_RUNTIME_MODE: 'source'
    }
  });
  return {
    status: Number.isFinite(out.status) ? Number(out.status) : 1,
    stdout: String(out.stdout || ''),
    stderr: String(out.stderr || '')
  };
}

try {
  let out = run(['run']);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  let payload = JSON.parse(out.stdout);
  assert.strictEqual(payload.type, 'rust_hotpath_inventory');
  assert.ok(payload.totals && Number.isFinite(Number(payload.totals.tracked_ts_lines)), 'expected tracked_ts_lines');
  assert.ok(payload.totals && Number.isFinite(Number(payload.totals.tracked_rs_lines)), 'expected tracked_rs_lines');
  assert.ok(Array.isArray(payload.top_directories) && payload.top_directories.length > 0, 'expected top_directories');
  assert.ok(Array.isArray(payload.top_files) && payload.top_files.length > 0, 'expected top_files');
  assert.ok(Array.isArray(payload.milestones) && payload.milestones.length > 0, 'expected milestones');

  out = run(['status']);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  payload = JSON.parse(out.stdout);
  assert.strictEqual(payload.type, 'rust_hotpath_inventory_status');
  assert.ok(payload.latest && payload.latest.ok === true, 'status must include latest successful artifact');

  console.log('rust_hotpath_inventory.test.js: OK');
} catch (err) {
  console.error(`rust_hotpath_inventory.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
