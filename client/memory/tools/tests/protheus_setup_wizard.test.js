#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const PROTHEUSCTL = path.join(ROOT, 'systems', 'ops', 'protheusctl.js');

function parseJson(raw) {
  const txt = String(raw || '').trim();
  if (!txt) return null;
  try {
    return JSON.parse(txt);
  } catch {}
  const lines = txt.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i]);
    } catch {}
  }
  return null;
}

function run(args, env = {}, input) {
  const out = spawnSync(process.execPath, [PROTHEUSCTL, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    input,
    env: {
      ...process.env,
      PROTHEUS_RUNTIME_MODE: 'source',
      PROTHEUS_CTL_SECURITY_GATE_DISABLED: '1',
      PROTHEUS_CLI_SUGGESTIONS: '0',
      PROTHEUS_UPDATE_CHECKER_DISABLED: '1',
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'protheus-setup-wizard-'));
  const setupStateDir = path.join(tmp, 'setup_state');
  const suggestionStateDir = path.join(tmp, 'suggestion_state');

  let out = run([
    'setup',
    'run',
    '--json=1',
    '--covenant-accept=y',
    '--interaction=silent',
    '--notifications=off',
    '--persona-customize=off'
  ], {
    PROTHEUS_SETUP_STATE_DIR: setupStateDir,
    PROTHEUS_CLI_SUGGESTION_STATE_DIR: suggestionStateDir
  });

  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.type === 'protheus_setup_wizard', 'expected setup payload');
  assert.strictEqual(out.payload.completed, true, 'setup should complete');
  assert.strictEqual(out.payload.settings.interaction_mode, 'silent', 'interaction mode should persist');

  out = run(['setup', 'should-run', '--json=1'], {
    PROTHEUS_SETUP_STATE_DIR: setupStateDir
  });
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.type === 'protheus_setup_should_run', 'expected should-run payload');
  assert.strictEqual(out.payload.should_run, false, 'setup should not be required after completion');

  const tmpAuto = fs.mkdtempSync(path.join(os.tmpdir(), 'protheus-setup-autorun-'));
  const autoSetupDir = path.join(tmpAuto, 'setup_state');
  const autoSuggestionDir = path.join(tmpAuto, 'suggestion_state');
  out = run([], {
    PROTHEUS_FORCE_REPL: '1',
    PROTHEUS_SETUP_STATE_DIR: autoSetupDir,
    PROTHEUS_CLI_SUGGESTION_STATE_DIR: autoSuggestionDir
  }, 'y\nn\n1\ny\nexit\n');

  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.stdout.includes('Setup skipped.'), 'non-tty auto-run should skip setup safely');
  assert.ok(out.stdout.includes('Protheus Interactive Mode'), 'auto-run should continue into REPL');

  const tmpReject = fs.mkdtempSync(path.join(os.tmpdir(), 'protheus-setup-reject-'));
  out = run([
    'setup',
    'run',
    '--json=1',
    '--covenant-accept=n'
  ], {
    PROTHEUS_SETUP_STATE_DIR: path.join(tmpReject, 'setup_state')
  });
  assert.notStrictEqual(out.status, 0, 'rejecting covenant should fail closed');

  console.log('protheus_setup_wizard.test.js: OK');
} catch (err) {
  console.error(`protheus_setup_wizard.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
