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
  assert.strictEqual(r.status, 1, 'expected strict failure when TS pair change is missing');
  assert.ok(r.payload && r.payload.ok === false, 'payload ok=false expected');
  assert.ok(
    Array.isArray(r.payload.ts_pair_drift_violations) && r.payload.ts_pair_drift_violations.length >= 1,
    'expected ts_pair_drift violation for js-only change'
  );

  r = run(['run', '--strict', '--files=systems/spine/spine.js,systems/spine/spine.ts,docs/OPERATOR_RUNBOOK.md']);
  assert.strictEqual(r.status, 0, `expected pass when TS/JS pair both change; stderr=${r.stderr}`);
  assert.ok(r.payload && r.payload.ok === true, 'payload ok expected');

  r = run(['run', '--strict', '--files=state/autonomy/runs/2026-02-21.jsonl,memory/_snapshots/TAGS_INDEX-2026-02-14-1151.md']);
  assert.strictEqual(r.status, 1, 'expected strict failure for generated paths');
  assert.ok(r.payload && r.payload.violations >= 1, 'expected violations >= 1');

  r = run(['run', '--strict', '--files=systems/spine/spine.ts']);
  assert.strictEqual(r.status, 1, 'expected strict failure when JS pair change is missing');
  assert.ok(
    Array.isArray(r.payload.ts_pair_drift_violations)
      && r.payload.ts_pair_drift_violations.some((v) => String(v || '').includes('systems/spine/spine.ts')),
    'expected ts_pair_drift violation for ts-only change'
  );

  console.log('repo_hygiene_guard.test.js: OK');
} catch (err) {
  console.error(`repo_hygiene_guard.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
