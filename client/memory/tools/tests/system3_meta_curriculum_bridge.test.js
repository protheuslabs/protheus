#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'adaptive', 'executive', 'system3_meta_curriculum_bridge.js');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function parseJson(stdout) {
  const txt = String(stdout || '').trim();
  if (!txt) return null;
  try { return JSON.parse(txt); } catch {}
  const lines = txt.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function run(args) {
  const proc = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  return {
    status: Number.isFinite(proc.status) ? Number(proc.status) : 1,
    stdout: String(proc.stdout || ''),
    stderr: String(proc.stderr || ''),
    payload: parseJson(proc.stdout)
  };
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'system3-meta-curriculum-'));
  const policyPath = path.join(tmp, 'config', 'system3_meta_curriculum_bridge_policy.json');
  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    strict_default: true,
    event_stream: { enabled: false, publish: false, stream: 'executive.system3_curriculum' },
    scripts: {
      system3: 'client/adaptive/executive/system3_executive_layer.js',
      strategy_learner: 'client/systems/strategy/strategy_learner.js',
      model_catalog: 'client/systems/autonomy/model_catalog_loop.js'
    },
    paths: {
      memory_dir: path.join(tmp, 'memory', 'executive', 'system3_meta_curriculum_bridge'),
      adaptive_index_path: path.join(tmp, 'adaptive', 'executive', 'system3_meta_curriculum_bridge', 'index.json'),
      events_path: path.join(tmp, 'state', 'executive', 'system3_meta_curriculum_bridge', 'events.jsonl'),
      latest_path: path.join(tmp, 'state', 'executive', 'system3_meta_curriculum_bridge', 'latest.json'),
      receipts_path: path.join(tmp, 'state', 'executive', 'system3_meta_curriculum_bridge', 'receipts.jsonl'),
      curriculum_state_path: path.join(tmp, 'state', 'executive', 'system3_meta_curriculum_bridge', 'state.json'),
      curriculum_artifact_path: path.join(tmp, 'state', 'executive', 'system3_meta_curriculum_bridge', 'curriculum_latest.json')
    }
  });

  let out = run(['run', '--owner=jay', '--task=meta_curriculum', '--days=7', '--mock=1', '--apply=1', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.strictEqual(out.payload.event, 'system3_meta_curriculum_handoff');

  out = run(['status', '--owner=jay', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload.state && Number(out.payload.state.runs || 0) >= 1);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('system3_meta_curriculum_bridge.test.js: OK');
} catch (err) {
  console.error(`system3_meta_curriculum_bridge.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
