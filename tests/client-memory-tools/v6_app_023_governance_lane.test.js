#!/usr/bin/env node
/* eslint-disable no-console */
const assert = require('assert');
const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const RUNNER = path.join(ROOT, 'tests/tooling/scripts/ci/v6_app_023_governance_lane.mjs');
const IDS = [
  'V6-APP-023.7',
  'V6-APP-023.8',
  'V6-APP-023.9',
  'V6-APP-023.10',
  'V6-APP-023.11',
];

function parseLastJson(stdout) {
  const whole = String(stdout || '').trim();
  if (whole) {
    try {
      return JSON.parse(whole);
    } catch {}
  }
  const lines = whole
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let idx = lines.length - 1; idx >= 0; idx -= 1) {
    try {
      const parsed = JSON.parse(lines[idx]);
      if (parsed && typeof parsed === 'object') {
        return parsed;
      }
    } catch {}
  }
  return null;
}

for (const id of IDS) {
  const child = spawnSync('node', [RUNNER, `--id=${id}`, '--strict=1'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.strictEqual(child.status, 0, `${id} failed:\nSTDOUT:\n${child.stdout}\nSTDERR:\n${child.stderr}`);
  const payload = parseLastJson(child.stdout);
  assert(payload, `${id} did not emit JSON`);
  assert.strictEqual(payload.ok, true, `${id} not ok`);
  assert.strictEqual(payload.id, id, `${id} id mismatch`);
  assert.strictEqual(typeof payload.receipt_hash, 'string', `${id} missing receipt_hash`);
}

console.log(JSON.stringify({ ok: true, type: 'v6_app_023_governance_lane_test', ids: IDS }, null, 2));
