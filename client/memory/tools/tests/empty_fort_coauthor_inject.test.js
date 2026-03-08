#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const { spawnSync } = require('child_process');

(function main() {
  const repoRoot = path.resolve(__dirname, '../../../..');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'protheus-empty-fort-coauth-'));
  fs.mkdirSync(path.join(tmp, 'state/ops/evidence'), { recursive: true });

  const goodCsv = path.join(tmp, 'contributors.csv');
  fs.writeFileSync(
    goodCsv,
    [
      'github_username,email,consent_token',
      'alice-dev,alice-dev@users.noreply.github.com,token-a',
      'bob-ops,bob-ops@users.noreply.github.com,token-b'
    ].join('\n') + '\n'
  );

  const good = spawnSync('bash', [path.join(repoRoot, 'scripts/empty_fort_coauthor_inject.sh'), `--csv=${goodCsv}`, `--out-dir=${path.join(tmp, 'state/ops/evidence')}`], {
    cwd: tmp,
    encoding: 'utf8'
  });

  assert.strictEqual(good.status, 0, good.stderr || good.stdout);
  const files = fs.readdirSync(path.join(tmp, 'state/ops/evidence'));
  assert.ok(files.some((f) => f.startsWith('empty_fort_coauthors_') && f.endsWith('.txt')), 'missing trailers file');

  const badCsv = path.join(tmp, 'bad.csv');
  fs.writeFileSync(
    badCsv,
    [
      'github_username,email,consent_token',
      'alice-dev,alice@example.com,token-a'
    ].join('\n') + '\n'
  );

  const bad = spawnSync('bash', [path.join(repoRoot, 'scripts/empty_fort_coauthor_inject.sh'), `--csv=${badCsv}`], {
    cwd: tmp,
    encoding: 'utf8'
  });
  assert.notStrictEqual(bad.status, 0, 'invalid email should fail');

  console.log('ok empty_fort_coauthor_inject');
})();
