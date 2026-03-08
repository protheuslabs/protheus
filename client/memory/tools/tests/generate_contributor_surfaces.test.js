#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

(function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'protheus-contrib-surfaces-'));
  const manifestPath = path.join(tmp, 'manifest.json');
  const readmePath = path.join(tmp, 'README.md');
  const contributorsPath = path.join(tmp, 'CONTRIBUTORS.md');

  fs.writeFileSync(readmePath, '# Protheus\n\n## What This Repo Includes\n\n- item\n');
  fs.writeFileSync(manifestPath, JSON.stringify({
    contributors: [
      { login: 'bob-ops', name: 'Bob', contributions: ['infra'], joined_at: '2026-03-08' },
      { login: 'alice-dev', name: 'Alice', contributions: ['code', 'doc'], joined_at: '2026-03-08' }
    ]
  }, null, 2));

  const repoRoot = path.resolve(__dirname, '../../../..');
  const run = spawnSync('node', [
    path.join(repoRoot, 'scripts/generate_contributor_surfaces.js'),
    `--manifest=${manifestPath}`,
    `--readme=${readmePath}`,
    `--contributors=${contributorsPath}`
  ], { encoding: 'utf8' });

  assert.strictEqual(run.status, 0, run.stderr || run.stdout);
  const readme = fs.readFileSync(readmePath, 'utf8');
  const contributors = fs.readFileSync(contributorsPath, 'utf8');

  assert.ok(readme.includes('<!-- EMPTY_FORT:START -->'), 'missing start marker');
  assert.ok(readme.includes('2 verified contributors'), 'missing contributor count');
  assert.ok(contributors.includes('@alice-dev'), 'contributors file should include sorted users');

  console.log('ok generate_contributor_surfaces');
})();
