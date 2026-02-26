#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function parsePayload(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function run() {
  const root = path.resolve(__dirname, '..', '..', '..');
  const script = path.join(root, 'systems', 'ops', 'config_plane_pilot.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'config-plane-pilot-'));
  const cfgA = path.join(tmp, 'config', 'a.json');
  const cfgB = path.join(tmp, 'config', 'b.json');
  const cfgC = path.join(tmp, 'config', 'c.json');
  const policyPath = path.join(tmp, 'config', 'config_plane_pilot_policy.json');
  const centralPlane = path.join(tmp, 'state', 'ops', 'config_plane', 'pilot_latest.json');
  const migrationMap = path.join(tmp, 'docs', 'CONFIG_PLANE_PILOT_MAP.md');
  const shimMap = path.join(tmp, 'config', 'config_plane_compat_shims.json');
  const latestPath = path.join(tmp, 'state', 'ops', 'config_plane_pilot', 'latest.json');

  writeJson(cfgA, { version: '1.0', enabled: true, timeout_ms: 1000, retries: 2 });
  writeJson(cfgB, { version: '1.0', enabled: false, timeout_ms: 1200, retries: 1 });
  writeJson(cfgC, { version: '1.0', enabled: true, timeout_ms: 800, retries: 3, lane: 'canary' });

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    min_targets: 3,
    min_duplicate_reduction_ratio: 0.5,
    targets: [cfgA, cfgB, cfgC],
    outputs: {
      central_plane_path: centralPlane,
      migration_map_path: migrationMap,
      compat_shim_path: shimMap,
      latest_path: latestPath,
      history_path: path.join(tmp, 'state', 'ops', 'config_plane_pilot', 'history.jsonl')
    }
  });

  const passRun = spawnSync(process.execPath, [
    script,
    'run',
    `--policy=${policyPath}`,
    '--strict=1'
  ], {
    cwd: root,
    encoding: 'utf8'
  });
  assert.strictEqual(passRun.status, 0, passRun.stderr || 'pilot run should pass');
  const passPayload = parsePayload(passRun.stdout);
  assert.ok(passPayload && passPayload.pass === true, 'pilot should pass');
  assert.strictEqual(passPayload.checks.duplicate_reduction, true, 'duplicate reduction check should pass');
  assert.ok(fs.existsSync(centralPlane), 'central plane output should exist');
  assert.ok(fs.existsSync(migrationMap), 'migration map output should exist');
  assert.ok(fs.existsSync(shimMap), 'compat shim map should exist');
  const mapBody = String(fs.readFileSync(migrationMap, 'utf8') || '');
  assert.ok(mapBody.includes('Duplicate Key Pressure'), 'migration map should include duplicate pressure section');

  writeJson(policyPath, {
    version: '1.0-test-fail',
    enabled: true,
    min_targets: 3,
    min_duplicate_reduction_ratio: 1.0,
    targets: [cfgA, cfgB, cfgC],
    outputs: {
      central_plane_path: centralPlane,
      migration_map_path: migrationMap,
      compat_shim_path: shimMap,
      latest_path: latestPath,
      history_path: path.join(tmp, 'state', 'ops', 'config_plane_pilot', 'history.jsonl')
    }
  });
  // Force a failure by giving one unique-key config set (no duplicates).
  writeJson(cfgA, { only_a: true });
  writeJson(cfgB, { only_b: true });
  writeJson(cfgC, { only_c: true });
  const failRun = spawnSync(process.execPath, [
    script,
    'run',
    `--policy=${policyPath}`,
    '--strict=1'
  ], {
    cwd: root,
    encoding: 'utf8'
  });
  assert.strictEqual(failRun.status, 1, 'strict mode should fail when duplicate reduction gate fails');
  const failPayload = parsePayload(failRun.stdout);
  assert.ok(failPayload && failPayload.pass === false, 'payload should report failed gate');
  assert.strictEqual(failPayload.checks.duplicate_reduction, false, 'duplicate reduction should fail');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('config_plane_pilot.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`config_plane_pilot.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

