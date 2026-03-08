#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');

function run(scriptRel, args = []) {
  const out = spawnSync(process.execPath, [path.join(ROOT, scriptRel), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: process.env
  });
  const txt = String(out.stdout || '').trim();
  const payload = txt ? JSON.parse(txt) : {};
  return { status: out.status, payload, stderr: String(out.stderr || '') };
}

function main() {
  const spawnRes = run('systems/security/sandbox_subagent_scope_runtime.js', ['spawn', '--owner=test', '--scope=analysis', '--tools=gh-fix-ci,skill-installer', '--apply=1']);
  assert.strictEqual(spawnRes.status, 0, spawnRes.stderr);
  assert.strictEqual(spawnRes.payload.ok, true);
  assert.ok(spawnRes.payload.payload.agent.id);
  const agentId = spawnRes.payload.payload.agent.id;

  const termRes = run('systems/security/sandbox_subagent_scope_runtime.js', ['terminate', `--agent-id=${agentId}`, '--reason=test_end', '--apply=1']);
  assert.strictEqual(termRes.status, 0, termRes.stderr);
  assert.strictEqual(termRes.payload.ok, true);

  const snapRes = run('systems/security/sandbox_state_bridge.js', ['snapshot', '--workspace=client/systems', '--apply=1']);
  assert.strictEqual(snapRes.status, 0, snapRes.stderr);
  assert.strictEqual(snapRes.payload.ok, true);
  assert.ok(snapRes.payload.payload.snapshot.snapshot_id);

  const restoreRes = run('systems/security/sandbox_state_bridge.js', ['restore', '--snapshot-id=latest', '--apply=1']);
  assert.strictEqual(restoreRes.status, 0, restoreRes.stderr);
  assert.strictEqual(restoreRes.payload.ok, true);

  const loadRes = run('systems/security/sandbox_skill_loader.js', ['load', '--skill=gh-fix-ci', '--scope=incident', '--apply=1']);
  assert.strictEqual(loadRes.status, 0, loadRes.stderr);
  assert.strictEqual(loadRes.payload.ok, true);

  const compressPass = run('systems/security/sandbox_context_controls.js', ['compress', '--tokens=2000', '--max-tokens=8000', '--mode=trim']);
  assert.strictEqual(compressPass.status, 0, compressPass.stderr);
  assert.strictEqual(compressPass.payload.payload.action, 'pass');

  const compressTrim = run('systems/security/sandbox_context_controls.js', ['compress', '--tokens=12000', '--max-tokens=8000', '--mode=trim']);
  assert.strictEqual(compressTrim.status, 0, compressTrim.stderr);
  assert.strictEqual(compressTrim.payload.payload.action, 'trim');

  console.log('sandbox_next10_bundle.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`sandbox_next10_bundle.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
