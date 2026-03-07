#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(REPO_ROOT, 'systems', 'continuity', 'active_state_bridge.js');

function mkdirp(p) { fs.mkdirSync(p, { recursive: true }); }
function writeJson(p, obj) { mkdirp(path.dirname(p)); fs.writeFileSync(p, JSON.stringify(obj, null, 2)); }

function run(args, env) {
  const r = spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
  let payload = null;
  try { payload = JSON.parse(String(r.stdout || '').trim()); } catch {}
  return { status: r.status ?? 0, payload, stderr: String(r.stderr || '') };
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'continuity-bridge-'));
  const root = path.join(tmp, 'workspace');
  const continuityState = path.join(root, 'state', 'continuity');
  mkdirp(root);

  writeJson(path.join(root, 'state', 'autonomy', 'cooldowns.json'), { a: 1, api_key: 'secret' });
  writeJson(path.join(root, 'state', 'routing', 'route_state.json'), { selected_model: 'x' });
  writeJson(path.join(root, 'state', 'spawn', 'allocations.json'), { habits: 1 });
  writeJson(path.join(root, 'state', 'adaptive', 'strategy', 'outcome_fitness.json'), { pass_rate: 0.5 });
  writeJson(path.join(root, 'state', 'sensory', 'eyes', 'registry.json'), { eyes: [] });

  const env = {
    CONTINUITY_ROOT: root,
    CONTINUITY_STATE_DIR: continuityState
  };

  let r = run(['acquire', '--writer=testA', '--ttl-sec=120'], env);
  assert.strictEqual(r.status, 0, `acquire should pass: ${r.stderr}`);
  assert.ok(r.payload && r.payload.ok === true, 'acquire ok expected');

  r = run(['checkpoint', '--writer=testA', '--label=unit'], env);
  assert.strictEqual(r.status, 0, `checkpoint should pass: ${r.stderr}`);
  assert.ok(r.payload && r.payload.ok === true, 'checkpoint ok expected');
  const checkpointId = r.payload.checkpoint_id;
  assert.ok(checkpointId, 'checkpoint id expected');

  const ckptPath = path.join(continuityState, 'checkpoints', `${checkpointId}.json`);
  const ckpt = JSON.parse(fs.readFileSync(ckptPath, 'utf8'));
  const cooldown = ckpt.docs.find((d) => d.path === 'state/autonomy/cooldowns.json');
  assert.ok(cooldown, 'cooldowns doc expected');
  assert.strictEqual(cooldown.value.api_key, '[REDACTED]', 'secret fields must be redacted');

  r = run(['replay', '--writer=testA', `--checkpoint=${checkpointId}`, '--dry-run'], env);
  assert.strictEqual(r.status, 0, `replay dry-run should pass: ${r.stderr}`);
  assert.ok(r.payload && r.payload.ok === true, 'replay dry-run ok expected');

  r = run(['release', '--writer=testA'], env);
  assert.strictEqual(r.status, 0, `release should pass: ${r.stderr}`);
  assert.ok(r.payload && r.payload.ok === true, 'release ok expected');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('active_state_bridge.test.js: OK');
} catch (err) {
  console.error(`active_state_bridge.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
