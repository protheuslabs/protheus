#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'security', 'repo_hygiene_guard.js');

function run(args) {
  const r = spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8' });
  const out = String(r.stdout || '').trim();
  let payload = null;
  try { payload = JSON.parse(out); } catch {}
  return { status: r.status ?? 0, payload, stderr: String(r.stderr || '') };
}

try {
  let r = run(['run', '--strict', '--files=systems/spine/spine.js,docs/OPERATOR_RUNBOOK.md']);
  assert.strictEqual(r.status, 0, `expected pass; stderr=${r.stderr}`);
  assert.ok(r.payload && r.payload.ok === true, 'payload ok expected');

  r = run(['run', '--strict', '--files=state/autonomy/runs/2026-02-21.jsonl,memory/_snapshots/TAGS_INDEX-2026-02-14-1151.md']);
  assert.strictEqual(r.status, 1, 'expected strict failure for generated paths');
  assert.ok(r.payload && r.payload.violations >= 1, 'expected violations >= 1');

  console.log('repo_hygiene_guard.test.js: OK');
} catch (err) {
  console.error(`repo_hygiene_guard.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
