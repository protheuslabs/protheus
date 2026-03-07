#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'assimilation', 'trajectory_skill_distiller.js');

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
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

function run(args, env = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8'
  });
  return { status: Number(r.status || 0), payload: parsePayload(r.stdout), stderr: String(r.stderr || '') };
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trajectory-distiller-test-'));
  const policyPath = path.join(tmp, 'policy.json');
  writeJson(policyPath, {
    enabled: true,
    shadow_only: true,
    distill_min_steps: 3,
    output_root: path.join(tmp, 'state', 'profiles'),
    receipts_path: path.join(tmp, 'state', 'receipts.jsonl'),
    latest_path: path.join(tmp, 'state', 'latest.json')
  });
  const env = { TRAJECTORY_SKILL_DISTILLER_POLICY_PATH: policyPath };

  const trajectory = JSON.stringify([
    { step: 'open', ok: true },
    { step: 'fill', ok: true },
    { step: 'submit', ok: false },
    { step: 'retry', ok: true }
  ]);

  let r = run(['distill', `--trajectory-json=${trajectory}`, '--profile-id=skill_a'], env);
  assert.strictEqual(r.status, 0, `distill should pass: ${r.stderr}`);
  assert.ok(r.payload && r.payload.ok === true, 'distill should be ok');
  const outPath = path.join(ROOT, r.payload.output_path);
  assert.ok(fs.existsSync(outPath), 'distilled profile should exist');

  r = run(['status'], env);
  assert.strictEqual(r.status, 0, `status should pass: ${r.stderr}`);
  assert.ok(r.payload && r.payload.ok === true, 'status should be ok');

  console.log('trajectory_skill_distiller.test.js: OK');
}

try { main(); } catch (err) {
  console.error(`trajectory_skill_distiller.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
