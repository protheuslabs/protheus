#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const PROACTIVE = path.join(ROOT, 'systems', 'tools', 'proactive_assimilation.js');
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

function runNode(script, args, env = {}) {
  const out = spawnSync(process.execPath, [script, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      PROTHEUS_RUNTIME_MODE: 'source',
      PROTHEUS_CTL_SECURITY_GATE_DISABLED: '1',
      ...env
    }
  });
  return {
    status: Number.isFinite(out.status) ? Number(out.status) : 1,
    stdout: String(out.stdout || ''),
    stderr: String(out.stderr || ''),
    payload: parseJson(out.stdout)
  };
}

try {
  let out = runNode(PROACTIVE, [
    'scan',
    '--text=I just used client/docs/cognitive_toolkit.md for this workflow.',
    '--auto-confirm=1',
    '--dry-run=1',
    '--format=json',
    '--origin=test'
  ]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.type === 'proactive_assimilation', 'should return proactive assimilation envelope');
  assert.strictEqual(out.payload.suggested, true, 'should suggest assimilation for detected path mention');
  assert.ok(String(out.payload.prompt || '').includes('Assimilate it into the system? (y/n)'), 'should include natural prompt text');
  assert.strictEqual(out.payload.decision.confirmed, true, 'auto-confirm should confirm suggestion');
  assert.ok(out.payload.assimilation && out.payload.assimilation.ok === true, 'confirmed suggestion should run assimilation');

  out = runNode(PROTHEUSCTL, [
    'research',
    'I just used client/docs/cognitive_toolkit.md for this workflow',
    '--dry-run=1',
    '--auto-confirm-assimilate=1',
    '--format=json'
  ]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.type === 'research_result', 'research should return research_result payload');
  assert.ok(out.payload.proactive_assimilation, 'research should include proactive assimilation envelope');
  assert.strictEqual(out.payload.proactive_assimilation.suggested, true, 'research query should trigger proactive suggestion');
  assert.strictEqual(out.payload.proactive_assimilation.decision.confirmed, true, 'auto confirm should confirm during research flow');

  console.log('proactive_assimilation_suggestion.test.js: OK');
} catch (err) {
  console.error(`proactive_assimilation_suggestion.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
