#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const PROTHEUSCTL = path.join(ROOT, 'systems', 'ops', 'protheusctl.js');

function run(args, extraEnv = null, stdinInput = '') {
  const env = Object.assign({}, process.env, extraEnv || {});
  const proc = spawnSync(process.execPath, [PROTHEUSCTL, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env,
    input: String(stdinInput || '')
  });
  return {
    status: Number.isFinite(proc.status) ? Number(proc.status) : 1,
    stdout: String(proc.stdout || ''),
    stderr: String(proc.stderr || '')
  };
}

function parseJsonOut(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {}
  const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i]);
    } catch {}
  }
  return null;
}

try {
  // Regression checks (one per tool route)
  let out = run(['toolkit', 'list']);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  let payload = parseJsonOut(out.stdout);
  assert.ok(payload && payload.ok === true, 'toolkit list should return ok payload');
  const toolIds = Array.isArray(payload.tools) ? payload.tools.map((x) => String(x.id || '')) : [];
  for (const required of ['personas', 'dictionary', 'orchestration', 'blob-morphing', 'comment-mapper']) {
    assert.ok(toolIds.includes(required), `toolkit list should include ${required}`);
  }

  out = run(['toolkit', 'personas', '--list']);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(
    out.stdout.includes('vikram_menon') || out.stdout.includes('No personas found'),
    'personas route should surface list output or explicit empty-state'
  );
  const hasKnownPersona = out.stdout.includes('vikram_menon');

  out = run(['toolkit', 'dictionary', 'term', 'Binary Blobs']);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  payload = parseJsonOut(out.stdout);
  assert.ok(payload && payload.ok === true, 'dictionary term should return ok payload');
  assert.strictEqual(payload.tool, 'dictionary', 'dictionary route should identify itself');
  assert.strictEqual(payload.term, 'Binary Blobs', 'dictionary term should match entry');

  out = run(['toolkit', 'orchestration', 'status']);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  payload = parseJsonOut(out.stdout);
  assert.ok(payload && payload.ok === true, 'orchestration route should return ok');
  assert.ok(Array.isArray(payload.policy_validation_failures), 'orchestration route should expose policy validation state');
  assert.ok(payload.counts && typeof payload.counts === 'object', 'orchestration route should include artifact counters');

  out = run(['toolkit', 'blob-morphing', 'status']);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  payload = parseJsonOut(out.stdout);
  assert.ok(payload && payload.ok === true, 'blob-morphing route should return ok');
  assert.strictEqual(payload.tool, 'blob-morphing', 'blob route should identify tool');
  assert.ok(Array.isArray(payload.artifacts) && payload.artifacts.length >= 5, 'blob route should return artifact list');
  assert.ok(payload.manifest_exists === true, 'blob route should confirm manifest exists');

  out = run([
    'toolkit',
    'comment-mapper',
    '--persona=vikram_menon',
    '--query=Should we prioritize memory or security first?',
    '--gap=0',
    '--emotion=off',
    '--values=off'
  ]);
  if (hasKnownPersona) {
    assert.strictEqual(out.status, 0, out.stderr || out.stdout);
    assert.ok(out.stdout.includes('# Lens Response: Vikram Menon'), 'comment-mapper route should render lens markdown');
  } else {
    assert.notStrictEqual(out.status, 0, 'comment-mapper should fail without persona fixtures');
    assert.ok(
      out.stderr.includes('unknown_persona:vikram_menon') || out.stdout.includes('unknown_persona:vikram_menon'),
      'comment-mapper should emit unknown_persona marker when fixtures are absent'
    );
  }

  // Sovereignty/security checks (one per tool route, fail-closed expected)
  const blockedEnv = { PROTHEUS_CTL_SECURITY_COVENANT_VIOLATION: '1' };
  const blockedCases = [
    ['toolkit', 'personas', '--list'],
    ['toolkit', 'dictionary', 'list'],
    ['toolkit', 'orchestration', 'status'],
    ['toolkit', 'blob-morphing', 'status']
  ];
  if (hasKnownPersona) {
    blockedCases.push(['toolkit', 'comment-mapper', '--persona=vikram_menon', '--query=Should we prioritize memory or security first?', '--gap=0']);
  }

  for (const args of blockedCases) {
    out = run(args, blockedEnv);
    assert.notStrictEqual(out.status, 0, `dispatch security gate should block ${args.join(' ')}`);
    assert.ok(
      out.stderr.includes('security_gate_blocked') || out.stdout.includes('security_gate_blocked'),
      `security gate marker missing for ${args.join(' ')}`
    );
  }

  console.log('cognitive_toolkit_suite.test.js: OK');
} catch (err) {
  console.error(`cognitive_toolkit_suite.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
