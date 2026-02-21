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

function denverDay() {
  const d = new Date();
  const denverStr = d.toLocaleDateString('en-US', {
    timeZone: 'America/Denver',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  const [m, dd, y] = denverStr.split('/');
  return `${y}-${m.padStart(2, '0')}-${dd.padStart(2, '0')}`;
}

function run() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const scriptPath = path.join(repoRoot, 'habits', 'scripts', 'habit_gc.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'habit-gc-'));
  const registryPath = path.join(tmp, 'habits', 'registry.json');
  const routinesDir = path.join(tmp, 'habits', 'routines');
  const archiveDir = path.join(tmp, 'habits', '_archive');
  const memoryDir = path.join(tmp, 'memory');
  fs.mkdirSync(routinesDir, { recursive: true });
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.writeFileSync(path.join(memoryDir, `${denverDay()}.md`), '# day\n', 'utf8');

  const staleTs = new Date(Date.now() - (60 * 24 * 60 * 60 * 1000)).toISOString();
  fs.writeFileSync(path.join(routinesDir, 'active_stale.js'), 'module.exports={};\n', 'utf8');
  fs.writeFileSync(path.join(routinesDir, 'candidate_stale.js'), 'module.exports={};\n', 'utf8');

  writeJson(registryPath, {
    version: 1.5,
    max_active: 25,
    gc: { inactive_days: 30, min_uses_30d: 1 },
    habits: [
      {
        id: 'active_stale',
        name: 'Active stale',
        status: 'active',
        governance: { state: 'active', pinned: false, demote: { cooldown_minutes: 1440 } },
        entrypoint: path.join(routinesDir, 'active_stale.js'),
        last_used_at: staleTs,
        uses_30d: 0
      },
      {
        id: 'candidate_stale',
        name: 'Candidate stale',
        status: 'candidate',
        governance: { state: 'candidate', pinned: false },
        entrypoint: path.join(routinesDir, 'candidate_stale.js'),
        last_used_at: staleTs,
        uses_30d: 0
      }
    ]
  });

  const env = {
    ...process.env,
    HABIT_GC_REGISTRY_PATH: registryPath,
    HABIT_GC_ROUTINES_DIR: routinesDir,
    HABIT_GC_ARCHIVE_DIR: archiveDir,
    HABIT_GC_SNIPPET_DIR: memoryDir
  };

  const r = spawnSync(process.execPath, [scriptPath, '--apply'], {
    encoding: 'utf8',
    env
  });
  assert.strictEqual(r.status, 0, `habit_gc apply failed: ${r.stderr}\n${r.stdout}`);

  const reg = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  const active = reg.habits.find((h) => h.id === 'active_stale');
  const candidate = reg.habits.find((h) => h.id === 'candidate_stale');

  assert.strictEqual(active.governance.state, 'disabled', 'stale active should be demoted to disabled');
  assert.strictEqual(active.status, 'disabled', 'status should be disabled');
  assert.ok(fs.existsSync(path.join(routinesDir, 'active_stale.js')), 'demoted active routine should remain in routines');

  assert.strictEqual(candidate.governance.state, 'archived', 'stale candidate should be archived');
  assert.strictEqual(candidate.status, 'archived', 'candidate status should be archived');
  assert.ok(fs.existsSync(path.join(archiveDir, 'candidate_stale.js')), 'archived routine should move to archive dir');

  console.log('habit_gc_atrophy.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`habit_gc_atrophy.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
