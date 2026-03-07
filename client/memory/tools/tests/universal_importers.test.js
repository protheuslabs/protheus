#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'migration', 'universal_importers.js');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function run(workspaceRoot, args) {
  const res = spawnSync('node', [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      OPENCLAW_WORKSPACE: workspaceRoot
    }
  });
  let payload = null;
  try { payload = JSON.parse(String(res.stdout || '').trim()); } catch {}
  return {
    status: typeof res.status === 'number' ? res.status : 1,
    payload,
    stderr: String(res.stderr || '')
  };
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'universal-importers-'));
  const workspaceRoot = path.join(tmp, 'workspace');
  const policyPath = path.join(tmp, 'config', 'universal_importers_policy.json');

  const openfangPath = path.join(tmp, 'source', 'openfang.json');
  writeJson(openfangPath, {
    agents: [{ id: 'agent_1', name: 'Planner' }],
    tasks: [{ id: 'task_1', name: 'Summarize' }],
    workflows: [{ id: 'flow_1', name: 'PrimaryFlow' }],
    tools: [{ id: 'tool_1', name: 'Search' }]
  });

  const commonPath = path.join(tmp, 'source', 'common.json');
  writeJson(commonPath, {
    prompts: [{ id: 'p1' }, { id: 'p2' }],
    settings: { retries: 3 }
  });
  const yamlPath = path.join(tmp, 'source', 'common.yaml');
  fs.mkdirSync(path.dirname(yamlPath), { recursive: true });
  fs.writeFileSync(
    yamlPath,
    'enabled: true\\nretries: 3\\nname: \"alpha\"\\n',
    'utf8'
  );

  const policy = {
    enabled: true,
    strict_default: false,
    paths: {
      latest_path: path.join(tmp, 'state', 'importers', 'latest.json'),
      receipts_path: path.join(tmp, 'state', 'importers', 'receipts.jsonl'),
      reports_root: path.join(tmp, 'state', 'importers', 'reports'),
      mapped_root: path.join(tmp, 'state', 'importers', 'mapped')
    }
  };
  writeJson(policyPath, policy);

  let res = run(workspaceRoot, [
    'run',
    '--from=openfang',
    `--path=${openfangPath}`,
    '--apply=1',
    '--strict=1',
    `--policy=${policyPath}`
  ]);
  assert.strictEqual(res.status, 0, `openfang run should pass: ${res.stderr}`);
  assert.ok(res.payload && res.payload.ok === true, 'openfang payload should be ok');
  assert.strictEqual(res.payload.no_loss_transform, true, 'openfang import should be no-loss');
  assert.ok(res.payload.mapped_path, 'mapped path should exist when apply=1');

  const mappedAbs = path.join(workspaceRoot, res.payload.mapped_path);
  assert.ok(fs.existsSync(mappedAbs), 'mapped artifact should be written');

  res = run(workspaceRoot, [
    'run',
    '--from=crewai',
    `--path=${commonPath}`,
    '--apply=1',
    '--strict=1',
    `--policy=${policyPath}`
  ]);
  assert.strictEqual(res.status, 0, `crewai alias run should pass: ${res.stderr}`);
  assert.ok(res.payload && res.payload.source_engine === 'generic_json', 'alias should resolve to generic_json');
  assert.strictEqual(res.payload.no_loss_transform, true, 'generic_json import should be no-loss');

  res = run(workspaceRoot, [
    'run',
    '--from=yaml',
    `--path=${yamlPath}`,
    '--apply=1',
    '--strict=1',
    `--policy=${policyPath}`
  ]);
  assert.strictEqual(res.status, 0, `yaml alias run should pass: ${res.stderr}`);
  assert.ok(res.payload && res.payload.source_engine === 'generic_yaml', 'yaml alias should resolve to generic_yaml');
  assert.strictEqual(res.payload.no_loss_transform, true, 'generic_yaml import should be no-loss');

  res = run(workspaceRoot, ['status', `--policy=${policyPath}`]);
  assert.strictEqual(res.status, 0, `status should pass: ${res.stderr}`);
  assert.ok(res.payload && res.payload.type === 'universal_importers_status');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('universal_importers.test.js: OK');
} catch (err) {
  console.error(`universal_importers.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
