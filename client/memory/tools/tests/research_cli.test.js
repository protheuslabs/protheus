#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const PROTHEUSCTL = path.join(ROOT, 'systems', 'ops', 'protheusctl.js');

function parseJson(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function run(args, extraEnv = {}) {
  const out = spawnSync(process.execPath, [PROTHEUSCTL, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      PROTHEUS_RUNTIME_MODE: 'source',
      PROTHEUS_CTL_SECURITY_GATE_DISABLED: '1',
      ...extraEnv
    }
  });
  return {
    status: Number.isFinite(out.status) ? Number(out.status) : 1,
    stdout: String(out.stdout || ''),
    stderr: String(out.stderr || ''),
    payload: parseJson(out.stdout),
    errPayload: parseJson(out.stderr)
  };
}

try {
  let out = run(['research', 'creating a quant trading software', '--dry-run=1', '--format=json']);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.type === 'research_result', 'should return research_result payload');
  assert.strictEqual(out.payload.ok, true, 'research run should succeed');
  assert.strictEqual(out.payload.dry_run, true, 'dry-run should be true');
  assert.ok(out.payload.research_organ && typeof out.payload.research_organ.ok === 'boolean', 'research organ section should be present');
  assert.ok(out.payload.core5_review && typeof out.payload.core5_review.ok === 'boolean', 'core5 review section should be present');
  assert.ok(Array.isArray(out.payload.hybrid_search.hits), 'hybrid search hits should be present');
  assert.ok(typeof out.payload.sprint_prompt === 'string' && out.payload.sprint_prompt.includes('STRICT EXECUTION RULES ACTIVE'), 'implementation-style query should emit sprint prompt');

  out = run(['research', 'creating a quant trading software', '--dry-run=1'], {
    PROTHEUS_RESEARCH_FORCE_COVENANT_VIOLATION: '1'
  });
  assert.notStrictEqual(out.status, 0, 'forced covenant violation should fail closed');
  assert.ok(out.stderr.includes('covenant_violation_detected_for_research'), 'should emit covenant violation error');

  const longQuery = Array.from({ length: 200 }, () => 'quant').join(' ');
  out = run(['research', longQuery, '--dry-run=1', '--max-query-tokens=10', '--token-budget-mode=reject']);
  assert.notStrictEqual(out.status, 0, 'query over budget in reject mode should fail closed');
  assert.ok(out.stderr.includes('query_budget_exceeded'), 'should report budget exceeded error');

  console.log('research_cli.test.js: OK');
} catch (err) {
  console.error(`research_cli.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
