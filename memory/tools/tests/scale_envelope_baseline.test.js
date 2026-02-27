#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'scale_envelope_baseline.js');

function parseJson(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scale-envelope-'));
  const statePath = path.join(tmp, 'state', 'ops', 'scale_envelope', 'latest.json');
  const historyPath = path.join(tmp, 'state', 'ops', 'scale_envelope', 'history.jsonl');
  const run = spawnSync(process.execPath, [SCRIPT, 'run', '--strict=1'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      SCALE_ENVELOPE_STATE_PATH: statePath,
      SCALE_ENVELOPE_HISTORY_PATH: historyPath
    }
  });
  assert.strictEqual(run.status, 0, run.stderr || 'scale envelope run should pass');
  const payload = parseJson(run.stdout);
  assert.ok(payload && payload.ok === true, 'scale envelope payload should be ok');
  assert.ok(Number(payload.parity_score || 0) >= Number(payload.parity_threshold || 1), 'parity threshold should pass');
  assert.ok(fs.existsSync(statePath), 'state file should be written');
  assert.ok(fs.existsSync(historyPath), 'history file should be written');
  console.log('scale_envelope_baseline.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`scale_envelope_baseline.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
