#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const { systemResearch } = require(path.join(ROOT, 'systems', 'tools', 'research_api.js'));

function loopResearchStep(query) {
  return systemResearch(query, {
    dryRun: true,
    format: 'json',
    env: {
      PROTHEUS_CTL_SECURITY_GATE_DISABLED: '1'
    }
  });
}

try {
  const result = loopResearchStep('creating a quant trading software');
  assert.strictEqual(result.ok, true, `programmatic research failed: ${JSON.stringify(result)}`);
  assert.strictEqual(result.type, 'research_programmatic', 'should return programmatic envelope');
  assert.ok(result.payload && result.payload.type === 'research_result', 'nested payload should be research_result');
  assert.ok(result.payload.synthesis && typeof result.payload.synthesis.summary === 'string', 'synthesis summary should exist');
  assert.ok(typeof result.payload.sprint_prompt === 'string' && result.payload.sprint_prompt.length > 0, 'query should produce sprint prompt');

  const blocked = systemResearch('creating a quant trading software', {
    dryRun: true,
    format: 'json',
    env: {
      PROTHEUS_CTL_SECURITY_GATE_DISABLED: '1',
      PROTHEUS_RESEARCH_FORCE_COVENANT_VIOLATION: '1'
    }
  });
  assert.strictEqual(blocked.ok, false, 'forced covenant violation should fail in programmatic mode');
  assert.ok(String(blocked.error || '').includes('covenant_violation_detected_for_research'), 'should surface covenant error');

  console.log('research_programmatic_api.test.js: OK');
} catch (err) {
  console.error(`research_programmatic_api.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
