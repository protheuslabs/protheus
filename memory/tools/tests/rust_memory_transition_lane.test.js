#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'memory', 'rust_memory_transition_lane.js');

function run(args) {
  const r = spawnSync('node', [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8' });
  let payload = null;
  try { payload = JSON.parse(String(r.stdout || '').trim()); } catch {}
  return { status: Number.isFinite(r.status) ? r.status : 1, payload, stderr: String(r.stderr || '') };
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rust-mem-lane-'));
  const policyPath = path.join(tmp, 'policy.json');
  const stateRoot = path.join(tmp, 'state');
  const indexPath = path.join(tmp, 'MEMORY_INDEX.md');

  fs.writeFileSync(indexPath, '| node_id | title | file |\n|---|---|---|\n| `n1` | n1 | `memory/2026-02-28.md` |\n');

  writeJson(policyPath, {
    enabled: true,
    shadow_only: true,
    paths: {
      state_root: stateRoot,
      latest_path: path.join(stateRoot, 'latest.json'),
      receipts_path: path.join(stateRoot, 'receipts.jsonl'),
      selector_path: path.join(stateRoot, 'selector.json'),
      benchmark_path: path.join(stateRoot, 'bench.json'),
      memory_index_path: indexPath,
      rust_crate_path: path.join(ROOT, 'systems', 'rust', 'memory_box')
    }
  });

  let res = run(['pilot', `--policy=${policyPath}`]);
  assert.strictEqual(res.status, 0, res.stderr);
  assert.ok(res.payload && res.payload.ok === true, 'pilot should pass with crate');

  res = run(['benchmark', `--policy=${policyPath}`, '--runs=3']);
  assert.strictEqual(res.status, 0, res.stderr);

  res = run(['selector', `--policy=${policyPath}`, '--backend=rust']);
  assert.strictEqual(res.status, 0, res.stderr);

  res = run(['retire-check', `--policy=${policyPath}`]);
  assert.strictEqual(res.status, 0, res.stderr);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('rust_memory_transition_lane.test.js: OK');
} catch (err) {
  console.error(`rust_memory_transition_lane.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
