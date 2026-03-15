#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const { spawnSync } = require('child_process');

(function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'protheus-empty-fort-visuals-'));
  const manifestPath = path.join(tmp, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify({ contributors: [{ login: 'alice' }, { login: 'bob' }] }, null, 2));

  const repoRoot = path.resolve(__dirname, '../../../..');
  const outDir = path.join(tmp, 'out');
  const run = spawnSync('node', [
    path.join(repoRoot, 'tests/tooling/scripts/empty_fort_visuals.js'),
    `--manifest=${manifestPath}`,
    `--out-dir=${outDir}`,
    '--release-tag=v0.test'
  ], { cwd: repoRoot, encoding: 'utf8' });

  assert.strictEqual(run.status, 0, run.stderr || run.stdout);
  const jsonPath = path.join(outDir, 'empty_fort_visual_metrics.json');
  assert.ok(fs.existsSync(jsonPath), 'missing metrics json');

  const payload = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  assert.strictEqual(payload.contributors, 2, 'contributor count mismatch');
  assert.strictEqual(payload.release_tag, 'v0.test', 'release tag mismatch');
  assert.ok(Number(payload.commits) > 0, 'commit count should be > 0');

  console.log('ok empty_fort_visuals');
})();
