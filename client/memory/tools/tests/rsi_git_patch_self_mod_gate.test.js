#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'security', 'rsi_git_patch_self_mod_gate.js');

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
  const proc = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8' });
  return {
    status: Number.isFinite(proc.status) ? Number(proc.status) : 1,
    stdout: String(proc.stdout || ''),
    stderr: String(proc.stderr || ''),
    payload: parseJson(proc.stdout)
  };
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rsi-self-mod-gate-'));
  const policyPath = path.join(tmp, 'config', 'rsi_git_patch_self_mod_gate_policy.json');
  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    strict_default: true,
    event_stream: { enabled: false, publish: false, stream: 'security.rsi_git_patch_gate' },
    require_human_approval: true,
    min_dopamine_score: 1,
    patch_required: false,
    scripts: {
      rsi_bootstrap: path.join(ROOT, 'adaptive', 'rsi', 'rsi_bootstrap.js'),
      rsi_policy: path.join(ROOT, 'config', 'rsi_bootstrap_policy.json'),
      chaos: path.join(ROOT, 'systems', 'autonomy', 'red_team_harness.js'),
      constitution: path.join(ROOT, 'systems', 'security', 'constitution_guardian.js'),
      habit_lifecycle: path.join(ROOT, 'habits', 'scripts', 'reflex_habit_bridge.js'),
      dopamine: path.join(ROOT, 'habits', 'scripts', 'dopamine_engine.js')
    },
    paths: {
      memory_dir: path.join(tmp, 'memory', 'security', 'rsi_git_patch_self_mod_gate'),
      adaptive_index_path: path.join(tmp, 'adaptive', 'security', 'rsi_git_patch_self_mod_gate', 'index.json'),
      events_path: path.join(tmp, 'state', 'security', 'rsi_git_patch_self_mod_gate', 'events.jsonl'),
      latest_path: path.join(tmp, 'state', 'security', 'rsi_git_patch_self_mod_gate', 'latest.json'),
      receipts_path: path.join(tmp, 'state', 'security', 'rsi_git_patch_self_mod_gate', 'receipts.jsonl')
    }
  });

  let out = run(['evaluate', '--owner=jay', '--strict=1', '--mock=1', '--approved=0', `--policy=${policyPath}`]);
  assert.notStrictEqual(out.status, 0, 'strict mode should fail when approval is missing');
  assert.ok(out.payload && out.payload.error === 'self_mod_gate_denied');

  out = run(['evaluate', '--owner=jay', '--strict=1', '--mock=1', '--approved=1', '--apply=0', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.self_mod_gate_ok === true, 'approved evaluation should pass');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('rsi_git_patch_self_mod_gate.test.js: OK');
} catch (err) {
  console.error(`rsi_git_patch_self_mod_gate.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
