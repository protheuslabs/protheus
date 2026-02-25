#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function parsePayload(stdout) {
  const raw = String(stdout || '').trim();
  try { return JSON.parse(raw); } catch {}
  const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function run() {
  const root = path.resolve(__dirname, '..', '..', '..');
  const aliasPath = path.join(root, 'systems', 'workflow', 'orchestron_controller.js');
  const basePath = path.join(root, 'systems', 'workflow', 'workflow_controller.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestron-alias-'));
  const registryPath = path.join(tmp, 'state', 'adaptive', 'workflows', 'registry.json');

  const env = {
    ...process.env,
    WORKFLOW_REGISTRY_PATH: registryPath
  };

  const base = spawnSync(process.execPath, [basePath, 'status'], {
    cwd: root,
    encoding: 'utf8',
    env
  });
  assert.strictEqual(base.status, 0, base.stderr || 'base controller status should pass');
  const baseOut = parsePayload(base.stdout);
  assert.ok(baseOut && baseOut.ok === true, 'base output should be ok');
  assert.strictEqual(baseOut.type, 'workflow_controller_status', 'base type should match');

  const alias = spawnSync(process.execPath, [aliasPath, 'status'], {
    cwd: root,
    encoding: 'utf8',
    env
  });
  assert.strictEqual(alias.status, 0, alias.stderr || 'alias controller status should pass');
  const aliasOut = parsePayload(alias.stdout);
  assert.ok(aliasOut && aliasOut.ok === true, 'alias output should be ok');
  assert.strictEqual(aliasOut.type, 'workflow_controller_status', 'alias should delegate to workflow controller');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('orchestron_controller_alias.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`orchestron_controller_alias.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
