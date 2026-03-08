#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'protheusctl.js');

function parseLastJson(stdout) {
  const raw = String(stdout || '').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    // continue
  }
  const lines = raw.split(/\r?\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lines[i].trim().startsWith('{')) continue;
    try {
      return JSON.parse(lines.slice(i).join('\n'));
    } catch {
      // continue
    }
  }
  return {};
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-alias-'));
  const sourcePath = path.join(tmp, 'openfang.json');
  fs.writeFileSync(sourcePath, JSON.stringify({
    agents: [{ id: 'agent-1', role: 'planner' }],
    tasks: [{ id: 'task-1', title: 'demo task' }]
  }, null, 2));

  const out = spawnSync(process.execPath, [SCRIPT, 'migrate', '--from=openfang', `--path=${sourcePath}`, '--apply=0'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: process.env
  });

  const payload = parseLastJson(out.stdout);
  assert.strictEqual(out.status, 0, out.stderr);
  assert.strictEqual(payload.ok, true);
  assert.strictEqual(payload.type, 'universal_importers_run');
  assert.strictEqual(payload.source_engine, 'openfang');

  console.log('protheusctl_migrate_openfang_alias.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`protheusctl_migrate_openfang_alias.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
