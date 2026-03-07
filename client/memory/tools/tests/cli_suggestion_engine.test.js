#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SUGGEST = path.join(ROOT, 'systems', 'tools', 'cli_suggestion_engine.js');

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

function run(args, env = {}) {
  const out = spawnSync(process.execPath, [SUGGEST, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
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
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'protheus-cli-suggest-test-'));
  const policyPath = path.join(stateDir, 'policy.json');
  fs.writeFileSync(policyPath, JSON.stringify({
    version: 'test',
    enabled: true,
    tutorial_mode_default_new_users: true,
    cooldown_seconds: 0,
    max_suggestions_per_hour: 1000,
    core5_review_required: true,
    triggers: {
      drift_keywords: ['drift', 'regression', 'violation', 'fail', 'degrade', 'downgrade'],
      planning_keywords: ['plan', 'sprint', 'next', 'roadmap', 'backlog'],
      external_detection_enabled: true,
      first_use_orchestration_hint: true
    }
  }, null, 2));
  const env = {
    PROTHEUS_CLI_SUGGESTION_STATE_DIR: stateDir,
    PROTHEUS_CLI_SUGGESTION_POLICY_PATH: policyPath
  };

  let out = run([
    'suggest',
    '--cmd=status',
    '--text=I just used client/docs/cognitive_toolkit.md for this workflow.',
    '--auto-reject=1',
    '--dry-run=1',
    '--json=1'
  ], env);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.type === 'cli_suggestion', 'expected cli_suggestion envelope');
  assert.strictEqual(out.payload.suggestion.trigger, 'external_tool', 'expected external_tool trigger');
  assert.ok(String(out.payload.suggestion.command || '').includes('protheus assimilate'), 'expected assimilate suggestion');

  out = run([
    'suggest',
    '--cmd=status',
    '--text=drift regression detected in memory lane',
    '--auto-reject=1',
    '--dry-run=1',
    '--json=1'
  ], env);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.strictEqual(out.payload.suggestion.trigger, 'drift_signal', 'expected drift trigger');
  assert.ok(String(out.payload.suggestion.command || '').includes('protheus lens vikram'), 'expected lens review suggestion');

  out = run([
    'suggest',
    '--cmd=status',
    '--text=plan next sprint backlog for rust migration',
    '--auto-reject=1',
    '--dry-run=1',
    '--json=1'
  ], env);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.strictEqual(out.payload.suggestion.trigger, 'planning_intent', 'expected planning trigger');
  assert.ok(String(out.payload.suggestion.command || '').includes('protheus orchestrate meeting'), 'expected orchestration suggestion');

  // Sovereignty/safety check: fail-closed suggestion blocking when Core-5 review path is unavailable.
  const isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'protheus-cli-suggest-isolated-'));
  out = run([
    'suggest',
    '--cmd=status',
    '--text=I just used client/docs/cognitive_toolkit.md for this workflow.',
    '--auto-reject=1',
    '--dry-run=1',
    '--json=1'
  ], {
    PROTHEUS_CLI_SUGGESTION_STATE_DIR: stateDir,
    PROTHEUS_CLI_SUGGESTION_POLICY_PATH: policyPath,
    OPENCLAW_WORKSPACE: isolatedRoot
  });
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.strictEqual(out.payload.skipped, true, 'should skip when core5 review cannot run');
  assert.strictEqual(out.payload.skip_reason, 'core5_review_failed', 'should fail closed on core5 review failure');

  console.log('cli_suggestion_engine.test.js: OK');
} catch (err) {
  console.error(`cli_suggestion_engine.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
