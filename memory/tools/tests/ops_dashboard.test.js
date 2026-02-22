#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'autonomy', 'ops_dashboard.js');

function mkdirp(p) { fs.mkdirSync(p, { recursive: true }); }
function writeJson(p, obj) { mkdirp(path.dirname(p)); fs.writeFileSync(p, JSON.stringify(obj, null, 2)); }

function run(args, env) {
  const r = spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
  let payload = null;
  try { payload = JSON.parse(String(r.stdout || '').trim()); } catch {}
  return { status: r.status ?? 0, payload, stderr: String(r.stderr || '') };
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-dashboard-'));
  const reportsDir = path.join(tmp, 'reports');

  writeJson(path.join(reportsDir, '2026-02-21__daily.json'), {
    slo: {
      alert_level: 'warn',
      checks: [
        { name: 'dark_eye', pass: false },
        { name: 'proposal_starvation', pass: true },
        { name: 'loop_stall', pass: false },
        { name: 'drift', pass: true }
      ]
    }
  });

  const r = run(['run', '2026-02-21', '--days=1'], { AUTONOMY_HEALTH_REPORTS_DIR: reportsDir });
  assert.strictEqual(r.status, 0, `run should pass: ${r.stderr}`);
  assert.ok(r.payload && r.payload.ok === true, 'ok expected');
  assert.strictEqual(r.payload.summary.slo.dark_eye.fail, 1, 'dark_eye fail count expected');
  assert.strictEqual(r.payload.summary.slo.loop_stall.fail, 1, 'loop_stall fail count expected');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('ops_dashboard.test.js: OK');
} catch (err) {
  console.error(`ops_dashboard.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
