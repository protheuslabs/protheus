#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'obsidian', 'obsidian_phase_pack.js');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeText(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value, 'utf8');
}

function run(args) {
  const res = spawnSync('node', [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8' });
  let payload = null;
  try { payload = JSON.parse(String(res.stdout || '').trim()); } catch {}
  return { status: res.status == null ? 1 : res.status, payload, stderr: String(res.stderr || '') };
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'obsidian-phase-pack-'));
  const policyPath = path.join(tmp, 'config', 'obsidian_phase_pack_policy.json');
  const notePath = path.join(tmp, 'vault', 'todo.md');

  writeText(notePath, '# Task\n- [ ] Ship feature A\n- [ ] Validate canary\n');

  writeJson(policyPath, {
    enabled: true,
    shadow_only: true,
    paths: {
      vault_root: path.join(tmp, 'vault'),
      wisdom_root: path.join(tmp, 'state', 'obsidian', 'projections', 'wisdom'),
      cards_root: path.join(tmp, 'state', 'obsidian', 'projections', 'cards'),
      canvas_root: path.join(tmp, 'state', 'obsidian', 'projections', 'canvas'),
      intents_root: path.join(tmp, 'state', 'obsidian', 'intents'),
      mobile_root: path.join(tmp, 'state', 'obsidian', 'mobile'),
      identity_bus_path: path.join(tmp, 'state', 'obsidian', 'identity_bus.json'),
      plugin_state_path: path.join(tmp, 'state', 'obsidian', 'plugin_state.json'),
      latest_path: path.join(tmp, 'state', 'obsidian', 'phase_pack_latest.json'),
      receipts_path: path.join(tmp, 'state', 'obsidian', 'phase_pack_receipts.jsonl')
    }
  });

  let res = run(['wisdom-project', `--policy=${policyPath}`, '--title=Harmony Rule', '--principle=Stay bounded and auditable', '--holo-node-id=node_1', '--apply=1']);
  assert.strictEqual(res.status, 0, `wisdom-project should pass: ${res.stderr}`);

  res = run(['ops-card', `--policy=${policyPath}`, '--kind=doctor', '--status=ok', '--apply=1']);
  assert.strictEqual(res.status, 0, `ops-card should pass: ${res.stderr}`);

  res = run(['intent-compile', `--policy=${policyPath}`, `--note-path=${notePath}`, '--apply=1']);
  assert.strictEqual(res.status, 0, `intent-compile should pass: ${res.stderr}`);
  assert.ok(res.payload.step_count >= 2, 'intent steps expected');

  res = run(['canvas-map', `--policy=${policyPath}`, '--canvas-id=plan', '--nodes=Lead,Build,Send', '--apply=1']);
  assert.strictEqual(res.status, 0, `canvas-map should pass: ${res.stderr}`);
  assert.strictEqual(res.payload.node_count, 3);

  res = run(['identity-sync', `--policy=${policyPath}`, '--entity-id=lead_1', '--note=vault/lead.md', '--holo-node-id=holo_1', '--apply=1']);
  assert.strictEqual(res.status, 0, `identity-sync should pass: ${res.stderr}`);

  res = run(['plugin-control', `--policy=${policyPath}`, '--action=queue', '--pending-id=p_1', '--apply=1']);
  assert.strictEqual(res.status, 0, `plugin-control queue should pass: ${res.stderr}`);

  res = run(['phone-mode', `--policy=${policyPath}`, '--segments=wisdom,cards', '--apply=1']);
  assert.strictEqual(res.status, 0, `phone-mode should pass: ${res.stderr}`);

  res = run(['resilience-check', `--policy=${policyPath}`, '--strict=1']);
  assert.strictEqual(res.status, 0, `resilience-check should pass: ${res.stderr}`);

  res = run(['status', `--policy=${policyPath}`]);
  assert.strictEqual(res.status, 0, `status should pass: ${res.stderr}`);
  assert.ok(res.payload.identity_links >= 1, 'identity links expected');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('obsidian_phase_pack.test.js: OK');
} catch (err) {
  console.error(`obsidian_phase_pack.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
