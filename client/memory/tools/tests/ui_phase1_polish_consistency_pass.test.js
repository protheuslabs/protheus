#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'ui_phase1_polish_consistency_pass.js');

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
  return {
    status: Number.isFinite(proc.status) ? Number(proc.status) : 1,
    stdout: String(proc.stdout || ''),
    stderr: String(proc.stderr || ''),
    payload: parseJson(proc.stdout)
  };
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-polish-'));
  const policyPath = path.join(tmp, 'config', 'ui_phase1_polish_policy.json');
  const flagsPath = path.join(tmp, 'config', 'feature_flags.json');
  const specPath = path.join(tmp, 'docs', 'UI_PHASE1_TRADITIONAL_POLISH.md');
  const matrixPath = path.join(tmp, 'docs', 'UI_SURFACE_MATURITY_MATRIX.md');
  const latestPath = path.join(tmp, 'state', 'ops', 'ui_phase1_polish_consistency_pass', 'latest.json');
  const historyPath = path.join(tmp, 'state', 'ops', 'ui_phase1_polish_consistency_pass', 'history.jsonl');

  writeText(path.join(tmp, 'README.md'), 'readme\n');
  writeText(path.join(tmp, 'docs', 'ONBOARDING_PLAYBOOK.md'), 'onboarding\n');
  writeText(specPath, [
    'spacing typography motion states theme keyboard navigation command palette responsive',
    'aria keyboard focus contrast'
  ].join('\n'));
  writeText(matrixPath, 'surface matrix\n');

  writeJson(flagsPath, {
    phase1_ui_polish: false
  });

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    feature_flag_name: 'phase1_ui_polish',
    feature_flag_default: false,
    enable_on_apply: false,
    required_files: [
      'README.md',
      'client/docs/UI_SURFACE_MATURITY_MATRIX.md',
      'client/docs/UI_PHASE1_TRADITIONAL_POLISH.md',
      'client/docs/ONBOARDING_PLAYBOOK.md'
    ],
    required_sections: ['spacing', 'typography', 'motion', 'states', 'theme', 'keyboard navigation', 'command palette', 'responsive'],
    accessibility_terms: ['aria', 'keyboard', 'focus', 'contrast'],
    paths: {
      feature_flags_path: flagsPath,
      polish_spec_path: specPath,
      surface_matrix_path: matrixPath,
      latest_path: latestPath,
      history_path: historyPath
    }
  });

  let out = run(['verify', '--strict=1', `--policy=${policyPath}`], {
    OPENCLAW_WORKSPACE: tmp
  });
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.strictEqual(out.payload.ok, true, 'verify should pass with complete contract');

  out = run(['enable', `--policy=${policyPath}`], {
    OPENCLAW_WORKSPACE: tmp
  });
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.strictEqual(out.payload.enabled, true, 'enable should set feature flag');

  out = run(['disable', `--policy=${policyPath}`], {
    OPENCLAW_WORKSPACE: tmp
  });
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.strictEqual(out.payload.enabled, false, 'disable should clear feature flag');

  out = run(['status', `--policy=${policyPath}`], {
    OPENCLAW_WORKSPACE: tmp
  });
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.latest, 'status should expose latest verification payload');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('ui_phase1_polish_consistency_pass.test.js: OK');
} catch (err) {
  console.error(`ui_phase1_polish_consistency_pass.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
