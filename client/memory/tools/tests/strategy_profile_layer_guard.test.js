#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'strategy', 'strategy_profile_layer_guard.js');

function writeText(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text, 'utf8');
}
function writeJson(filePath, payload) { writeText(filePath, `${JSON.stringify(payload, null, 2)}\n`); }
function run(args, env) { return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, env: { ...process.env, ...env }, encoding: 'utf8' }); }
function parseJson(stdout) {
  const t = String(stdout || '').trim(); if (!t) return null;
  try { return JSON.parse(t); } catch {}
  const lines = t.split('\n').filter(Boolean); for (let i = lines.length - 1; i >= 0; i -= 1) { try { return JSON.parse(lines[i]); } catch {} }
  return null;
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'strategy-profile-'));
  const policyPath = path.join(tmp, 'config', 'strategy_profile_layer_policy.json');
  writeJson(path.join(tmp, 'config', 'strategies', 'active_profile.json'), { active_profile: 'default' });
  writeJson(path.join(tmp, 'config', 'strategies', 'default.json'), { id: 'default', execution_policy: { mode: 'score_only' } });
  writeText(path.join(tmp, 'systems', 'ok.ts'), 'export const x = 1;\n');
  writeText(path.join(tmp, 'systems', 'bad.ts'), 'const mode = "drop-shipping";\n');
  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    active_profile_path: path.join(tmp, 'config', 'strategies', 'active_profile.json'),
    profiles_dir: path.join(tmp, 'config', 'strategies'),
    guard: {
      enabled: true,
      scan_root: path.join(tmp, 'systems'),
      file_extensions: ['.ts'],
      skip_tokens: ['/tests/'],
      forbidden_profile_tokens: ['drop-shipping']
    },
    outputs: {
      latest_path: path.join(tmp, 'state', 'strategy', 'latest.json'),
      history_path: path.join(tmp, 'state', 'strategy', 'history.jsonl')
    }
  });

  const env = { STRATEGY_PROFILE_LAYER_ROOT: tmp, STRATEGY_PROFILE_LAYER_POLICY_PATH: policyPath };

  let r = run(['check', '--strict=1'], env);
  assert.notStrictEqual(r.status, 0, 'forbidden token in systems should fail strict check');
  let out = parseJson(r.stdout);
  assert.ok(out && out.blockers.some((b) => b.gate === 'architecture_genericity_guard'));

  writeText(path.join(tmp, 'systems', 'bad.ts'), 'const mode = "generic";\n');
  r = run(['check', '--strict=1'], env);
  assert.strictEqual(r.status, 0, r.stderr || 'clean genericity should pass');
  out = parseJson(r.stdout);
  assert.ok(out && out.ok === true && out.active_profile.execution_mode === 'score_only');

  console.log('strategy_profile_layer_guard.test.js: OK');
}

try { main(); } catch (err) { console.error(`strategy_profile_layer_guard.test.js: FAIL: ${err.message}`); process.exit(1); }
