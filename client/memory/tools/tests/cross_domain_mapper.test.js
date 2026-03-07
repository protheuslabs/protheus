#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

function mkDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function writeText(filePath, text) {
  mkDir(path.dirname(filePath));
  fs.writeFileSync(filePath, String(text || ''), 'utf8');
}

function run() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const { mapCrossDomainRows } = require(path.join(repoRoot, 'systems', 'memory', 'cross_domain_mapper.js'));

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cross-domain-mapper-'));
  const directivesDir = path.join(tmp, 'config', 'directives');
  mkDir(directivesDir);

  writeText(path.join(directivesDir, 'ACTIVE.yaml'), [
    'active_directives:',
    '  - id: T1_root',
    '    tier: 1',
    '    status: active',
    '  - id: T2_growth',
    '    tier: 2',
    '    status: active',
    '    parent_directive_id: T1_root',
    ''
  ].join('\n'));
  writeText(path.join(directivesDir, 'T1_root.yaml'), [
    'metadata:',
    '  parent_directive_id: ""',
    ''
  ].join('\n'));
  writeText(path.join(directivesDir, 'T2_growth.yaml'), [
    'metadata:',
    '  parent_directive_id: T1_root',
    ''
  ].join('\n'));

  const rowsA = [
    {
      token: 'market-signal-loop',
      score: 20,
      occurrences_window: 4,
      refs: ['client/memory/2026-02-20.md#market-loop'],
      objective_id: 'T2_growth'
    }
  ];
  const rowsB = [
    {
      token: 'signal-loop-automation',
      score: 19,
      occurrences_window: 3,
      refs: ['client/memory/2026-02-21.md#automation-loop'],
      objective_id: 'T2_growth'
    }
  ];

  const out = mapCrossDomainRows({
    domain_a: 'dream',
    rows_a: rowsA,
    domain_b: 'hyper_creative',
    rows_b: rowsB
  }, {
    active_path: path.join(directivesDir, 'ACTIVE.yaml'),
    directives_dir: directivesDir,
    require_objective: true,
    require_t1_root: true,
    max_mappings: 5,
    min_pair_score: 1,
    min_value_score: 1
  });

  assert.strictEqual(out.ok, true, 'mapper should return ok');
  assert.ok(Array.isArray(out.selected) && out.selected.length >= 1, 'mapper should produce at least one mapping');
  const first = out.selected[0];
  assert.ok(String(first.token || '').includes('signal-loop') || String(first.token || '').includes('loop-signal'), 'mapping token should include shared concepts');
  assert.strictEqual(String(first.objective_id || ''), 'T2_growth', 'mapping should preserve objective');
  assert.ok(Array.isArray(first.lineage_path) && first.lineage_path[0] === 'T1_root', 'mapping lineage should root to T1');

  const strictFail = mapCrossDomainRows({
    domain_a: 'a',
    rows_a: [{ token: 'x-signal', score: 10 }],
    domain_b: 'b',
    rows_b: [{ token: 'signal-y', score: 10 }]
  }, {
    active_path: path.join(directivesDir, 'ACTIVE.yaml'),
    directives_dir: directivesDir,
    require_objective: true,
    require_t1_root: true,
    default_objective_id: 'T2_bad_missing',
    max_mappings: 5,
    min_pair_score: 1,
    min_value_score: 1
  });
  assert.strictEqual(strictFail.ok, true, 'strict fail run should still return ok payload');
  assert.strictEqual(strictFail.selected.length, 0, 'invalid objective lineage should block mappings');
  assert.ok(Number(strictFail.rejected && strictFail.rejected.objective_invalid || 0) >= 1, 'should track objective invalid rejections');

  console.log('cross_domain_mapper.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`cross_domain_mapper.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

