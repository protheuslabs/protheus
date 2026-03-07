#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'ui_surface_maturity_pack.js');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeText(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text, 'utf8');
}

function parseJson(stdout) {
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
  const proc = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8'
  });
  return { status: Number.isFinite(proc.status) ? Number(proc.status) : 1, stdout: String(proc.stdout || ''), stderr: String(proc.stderr || ''), payload: parseJson(proc.stdout) };
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-fort-'));
  const policyPath = path.join(tmp, 'config', 'ui_surface_maturity_pack_policy.json');
  const latestPath = path.join(tmp, 'state', 'ops', 'ui_surface_maturity_pack', 'latest.json');
  const historyPath = path.join(tmp, 'state', 'ops', 'ui_surface_maturity_pack', 'history.jsonl');

  writeText(path.join(tmp, 'README.md'), 'client/docs/UI_SURFACE_MATURITY_MATRIX.md\nclient/docs/UI_SURFACE_INVENTORY.md\nclient/docs/UI_ACCESSIBILITY_INTERACTION_CONTRACT.md\n');
  writeText(path.join(tmp, 'docs', 'UI_SURFACE_MATURITY_MATRIX.md'), 'keyboard focus contrast command palette responsive\n');
  writeText(path.join(tmp, 'docs', 'UI_SURFACE_INVENTORY.md'), 'inventory\n');
  writeText(path.join(tmp, 'docs', 'UI_DESIGN_TOKEN_STANDARD.md'), 'tokens\n');
  writeText(path.join(tmp, 'docs', 'UI_ACCESSIBILITY_INTERACTION_CONTRACT.md'), 'keyboard focus contrast command palette responsive\n');

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    required_docs: [
      'client/docs/UI_SURFACE_MATURITY_MATRIX.md',
      'client/docs/UI_SURFACE_INVENTORY.md',
      'client/docs/UI_DESIGN_TOKEN_STANDARD.md',
      'client/docs/UI_ACCESSIBILITY_INTERACTION_CONTRACT.md'
    ],
    readme_path: path.join(tmp, 'README.md'),
    readme_required_links: [
      'client/docs/UI_SURFACE_MATURITY_MATRIX.md',
      'client/docs/UI_SURFACE_INVENTORY.md',
      'client/docs/UI_ACCESSIBILITY_INTERACTION_CONTRACT.md'
    ],
    required_terms: ['keyboard', 'focus', 'contrast', 'command palette', 'responsive'],
    paths: { latest_path: latestPath, history_path: historyPath }
  });

  const out = run(['verify', '--strict=1', `--policy=${policyPath}`], { OPENCLAW_WORKSPACE: tmp });
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.strictEqual(out.payload.ok, true, 'verify should pass');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('ui_surface_maturity_pack.test.js: OK');
} catch (err) {
  console.error(`ui_surface_maturity_pack.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
