#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'primitives', 'effect_type_system.js');

function parseJson(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'effect-type-system-'));
  const safePath = path.join(tmp, 'safe.json');
  const blockedPath = path.join(tmp, 'blocked.json');

  fs.writeFileSync(safePath, JSON.stringify({
    id: 'wf_safe',
    objective_id: 'obj_safe',
    steps: [
      {
        id: 'step_shell',
        type: 'command',
        adapter: 'shell_task',
        command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify('process.exit(0)')}`
      },
      {
        id: 'step_fs',
        type: 'command',
        adapter: 'filesystem_task',
        command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify('process.exit(0)')}`
      }
    ]
  }, null, 2));

  fs.writeFileSync(blockedPath, JSON.stringify({
    id: 'wf_blocked',
    objective_id: 'obj_blocked',
    steps: [
      {
        id: 'step_money',
        type: 'command',
        adapter: 'payment_task',
        command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify('process.exit(0)')}`
      },
      {
        id: 'step_shell',
        type: 'command',
        adapter: 'shell_task',
        command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify('process.exit(0)')}`
      }
    ]
  }, null, 2));

  const safeRun = spawnSync(process.execPath, [
    SCRIPT,
    'evaluate',
    `--workflow-json=@${safePath}`,
    '--strict=1'
  ], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  assert.strictEqual(safeRun.status, 0, safeRun.stderr || 'safe workflow should pass effect gate');
  const safeOut = parseJson(safeRun.stdout);
  assert.ok(safeOut && safeOut.ok === true, 'safe workflow output should be ok');
  assert.strictEqual(safeOut.decision, 'allow', 'safe workflow decision should be allow');
  assert.ok(Array.isArray(safeOut.transitions) && safeOut.transitions.length === 1, 'safe workflow should emit transition metadata');

  const blockedRun = spawnSync(process.execPath, [
    SCRIPT,
    'evaluate',
    `--workflow-json=@${blockedPath}`,
    '--strict=1'
  ], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  assert.notStrictEqual(blockedRun.status, 0, 'blocked workflow should fail strict mode');
  const blockedOut = parseJson(blockedRun.stdout);
  assert.ok(blockedOut && blockedOut.ok === false, 'blocked workflow output should fail');
  assert.strictEqual(blockedOut.decision, 'deny', 'blocked workflow should deny');
  const errorCodes = new Set((Array.isArray(blockedOut.errors) ? blockedOut.errors : []).map((row) => String(row && row.code || '')));
  assert.ok(errorCodes.has('forbidden_transition'), 'blocked workflow should include forbidden_transition error');
  assert.ok(errorCodes.has('forbidden_cooccurrence'), 'blocked workflow should include forbidden_cooccurrence error');

  console.log('effect_type_system.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`effect_type_system.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
