#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function writeJson(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function runGuard(scriptPath, env, strict = true) {
  const args = [scriptPath, 'run'];
  if (strict) args.push('--strict');
  const r = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    env
  });
  const payload = (() => {
    try { return JSON.parse(String(r.stdout || '{}')); } catch { return null; }
  })();
  return { status: r.status, payload, stderr: String(r.stderr || '') };
}

function run() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const scriptPath = path.join(repoRoot, 'systems', 'security', 'habit_hygiene_guard.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'habit-hygiene-'));
  const routinesDir = path.join(tmp, 'habits', 'routines');
  const registryPath = path.join(tmp, 'habits', 'registry.json');

  fs.mkdirSync(routinesDir, { recursive: true });
  fs.writeFileSync(path.join(routinesDir, 'good_habit.js'), 'module.exports={};\n', 'utf8');

  writeJson(registryPath, {
    version: 1.5,
    gc: { inactive_days: 30, min_uses_30d: 1 },
    habits: [
      {
        id: 'good_habit',
        uid: 'h123abc456def789ghi012jk',
        status: 'candidate',
        governance: { state: 'candidate', pinned: false },
        entrypoint: 'habits/routines/good_habit.js',
        provenance: {
          source: 'repeat_trigger',
          created_by: 'test',
          trigger_metrics: { repeats_14d: 3, tokens_est: 600, errors_30d: 0, which_met: ['A'] }
        }
      }
    ]
  });

  const env = {
    ...process.env,
    HABIT_HYGIENE_REGISTRY_PATH: registryPath,
    HABIT_HYGIENE_ROUTINES_DIR: routinesDir
  };

  const okRun = runGuard(scriptPath, env, true);
  assert.strictEqual(okRun.status, 0, `expected strict pass: ${okRun.stderr}`);
  assert.ok(okRun.payload && okRun.payload.ok === true, 'payload should indicate ok');

  fs.writeFileSync(path.join(routinesDir, 'orphan.js'), 'module.exports={};\n', 'utf8');
  const badRun = runGuard(scriptPath, env, true);
  assert.notStrictEqual(badRun.status, 0, 'strict mode should fail on orphan routine');
  assert.ok(badRun.payload && badRun.payload.ok === false, 'payload should indicate fail');
  assert.ok(
    Array.isArray(badRun.payload.violations) && badRun.payload.violations.some((v) => v.type === 'orphan_routine_file'),
    'should report orphan routine file'
  );

  console.log('habit_hygiene_guard.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`habit_hygiene_guard.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
