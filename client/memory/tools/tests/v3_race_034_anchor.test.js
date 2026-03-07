#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'backlog_runtime_anchors', 'v3_race_034_anchor.js');

function parseJson(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

try {
  const out = spawnSync(process.execPath, [SCRIPT], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  const payload = parseJson(out.stdout);
  assert.ok(payload && payload.ok === true, 'anchor should return ok=true');
  assert.strictEqual(String(payload.type || ''), 'backlog_runtime_anchor');
  assert.strictEqual(String(payload.lane_id || ''), 'V3-RACE-034');
  assert.ok(String(payload.anchor_hash || '').length >= 16, 'anchor hash should be present');
  console.log('v3_race_034_anchor.test.js: OK');
} catch (err) {
  console.error(`v3_race_034_anchor.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
