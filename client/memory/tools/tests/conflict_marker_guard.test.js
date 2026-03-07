#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'security', 'conflict_marker_guard.js');
const FIXTURE_REL = path.posix.join('systems', 'security', '__conflict_marker_guard_fixture__.ts');
const FIXTURE_ABS = path.join(ROOT, FIXTURE_REL);

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

function run(args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  return {
    status: Number(r.status || 0),
    payload: parseJson(r.stdout),
    stderr: String(r.stderr || '')
  };
}

function main() {
  const clean = run(['run', '--strict=1', '--files=client/systems/security/merge_guard.ts']);
  assert.strictEqual(clean.status, 0, `expected clean baseline to pass; stderr=${clean.stderr}`);
  assert.ok(clean.payload && clean.payload.ok === true, 'baseline payload should be ok');

  try {
    fs.writeFileSync(
      FIXTURE_ABS,
      [
        "export {};",
        '<<<<<<< HEAD',
        'const value = "left";',
        '=======',
        'const value = "right";',
        '>>>>>>> feature/branch',
        ''
      ].join('\n'),
      'utf8'
    );

    const strictFail = run(['run', '--strict=1', `--files=${FIXTURE_REL}`]);
    assert.strictEqual(strictFail.status, 1, 'expected strict mode to fail when markers exist');
    assert.ok(strictFail.payload && strictFail.payload.ok === false, 'strict payload ok should be false');
    assert.ok(Number(strictFail.payload.violations_count || 0) >= 3, 'expected marker violations to be detected');
    const markers = new Set((strictFail.payload.violations || []).map((row) => String(row.marker || '')));
    assert.ok(markers.has('<<<<<<<') && markers.has('=======') && markers.has('>>>>>>>'), 'all marker types should be detected');

    const advisory = run(['run', '--strict=0', `--files=${FIXTURE_REL}`]);
    assert.strictEqual(advisory.status, 0, 'expected non-strict mode to return zero exit code');
    assert.ok(advisory.payload && advisory.payload.ok === false, 'advisory payload should still report failure');
    assert.ok(Array.isArray(advisory.payload.remediation) && advisory.payload.remediation.length >= 1, 'expected remediation guidance');
  } finally {
    try {
      if (fs.existsSync(FIXTURE_ABS)) fs.unlinkSync(FIXTURE_ABS);
    } catch {}
  }

  console.log('conflict_marker_guard.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`conflict_marker_guard.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
