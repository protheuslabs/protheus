#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const { systemAssimilate } = require(path.join(ROOT, 'systems', 'tools', 'assimilate_api.js'));

function runLoopAssimilationStep(targetPath) {
  return systemAssimilate(targetPath, {
    dryRun: true,
    format: 'json',
    env: {
      PROTHEUS_CTL_SECURITY_GATE_DISABLED: '1'
    }
  });
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'protheus-assimilate-loop-'));
  const target = path.join(tmp, 'loop_source.md');
  fs.writeFileSync(
    target,
    [
      '# Loop Candidate',
      '',
      '- Must add one deterministic replay receipt check.',
      '- Should enforce sovereignty gate before apply.',
      '- Add one regression test for loop proposal intake.'
    ].join('\n'),
    'utf8'
  );

  const result = runLoopAssimilationStep(target);
  assert.strictEqual(result.ok, true, `expected programmatic assimilate success, got: ${JSON.stringify(result)}`);
  assert.strictEqual(result.type, 'assimilate_programmatic', 'should return programmatic envelope');
  assert.ok(result.payload && result.payload.type === 'assimilate_result', 'nested payload should be assimilate_result');
  assert.strictEqual(result.payload.dry_run, true, 'dry-run should be true for loop simulation');
  assert.ok(Array.isArray(result.payload.requirements), 'requirements array should be present');
  assert.ok(result.payload.sprint_prompt.includes('STRICT EXECUTION RULES ACTIVE'), 'should emit codex-ready sprint prompt');
  assert.ok(result.payload.core5_review && typeof result.payload.core5_review.ok === 'boolean', 'core5 review should be present');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('assimilate_programmatic_api.test.js: OK');
} catch (err) {
  console.error(`assimilate_programmatic_api.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
