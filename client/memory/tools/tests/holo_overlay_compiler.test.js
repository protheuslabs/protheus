#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function run(script, args) {
  const proc = spawnSync(process.execPath, [script, ...args], {
    cwd: path.resolve(__dirname, '..', '..', '..'),
    encoding: 'utf8'
  });
  const text = String(proc.stdout || '').trim();
  let payload = null;
  try { payload = JSON.parse(text); } catch {
    const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      try { payload = JSON.parse(lines[i]); break; } catch {}
    }
  }
  return { status: Number(proc.status || 0), payload, stderr: String(proc.stderr || '') };
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function main() {
  const root = path.resolve(__dirname, '..', '..', '..');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'holo-overlay-'));
  const policyPath = path.join(tmp, 'overlay_policy.json');

  writeJson(path.join(tmp, 'fusion.json'), { fusion_state: 'coherent' });
  writeJson(path.join(tmp, 'resonance.json'), { band: 'balanced' });
  writeJson(path.join(tmp, 'inversion.json'), { shadow_pressure: 0.22 });
  writeJson(path.join(tmp, 'runtime.json'), { molt_window: 'open' });
  writeJson(path.join(tmp, 'router.json'), { selected_lane: 'cheap', providers: [{ provider: 'openai', status: 'ok' }] });
  writeJson(path.join(tmp, 'weaver.json'), { trust_posture: 'stable' });

  writeJson(policyPath, {
    enabled: true,
    shadow_only: true,
    paths: {
      latest_path: path.join(tmp, 'latest.json'),
      receipts_path: path.join(tmp, 'receipts.jsonl'),
      overlay_path: path.join(tmp, 'overlay.json'),
      fusion_path: path.join(tmp, 'fusion.json'),
      resonance_path: path.join(tmp, 'resonance.json'),
      inversion_path: path.join(tmp, 'inversion.json'),
      runtime_path: path.join(tmp, 'runtime.json'),
      router_path: path.join(tmp, 'router.json'),
      weaver_path: path.join(tmp, 'weaver.json')
    }
  });

  const script = path.join(root, 'systems', 'ops', 'holo_overlay_compiler.js');
  let out = run(script, ['compile', '--apply=1', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || 'compile should succeed');
  assert.strictEqual(out.payload.ok, true, 'compile payload should be ok');

  const overlay = JSON.parse(fs.readFileSync(path.join(tmp, 'overlay.json'), 'utf8'));
  assert.strictEqual(String(overlay.emergence.fusion_state), 'coherent', 'fusion should be projected');
  assert.strictEqual(String(overlay.control_plane.routing_lane), 'cheap', 'routing lane should be projected');

  out = run(script, ['status', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || 'status should succeed');
  assert.strictEqual(out.payload.ok, true, 'status payload should be ok');

  console.log('holo_overlay_compiler.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`holo_overlay_compiler.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
