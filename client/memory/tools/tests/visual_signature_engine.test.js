#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'identity', 'visual_signature_engine.js');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
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

function run(args) {
  const proc = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'visual-signature-'));
  const policyPath = path.join(tmp, 'config', 'visual_signature_engine_policy.json');
  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    strict_default: true,
    constraints: { max_render_history: 20 },
    event_stream: {
      enabled: false,
      publish: false,
      stream: 'identity.visual_signature'
    },
    paths: {
      memory_dir: path.join(tmp, 'memory', 'identity', 'signature'),
      adaptive_index_path: path.join(tmp, 'adaptive', 'identity', 'signature', 'index.json'),
      style_tuning_path: path.join(tmp, 'adaptive', 'identity', 'signature', 'style_tuning.json'),
      events_path: path.join(tmp, 'state', 'identity', 'visual_signature', 'events.jsonl'),
      latest_path: path.join(tmp, 'state', 'identity', 'visual_signature', 'latest.json'),
      receipts_path: path.join(tmp, 'state', 'identity', 'visual_signature', 'receipts.jsonl'),
      manifests_dir: path.join(tmp, 'state', 'identity', 'visual_signature', 'manifests')
    }
  });

  let out = run([
    'configure',
    '--owner=jay',
    '--theme=ember',
    '--complexity=3',
    `--policy=${policyPath}`
  ]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.ok === true, 'configure should pass');

  out = run([
    'render',
    '--owner=jay',
    '--apply=1',
    '--risk-tier=2',
    `--policy=${policyPath}`
  ]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.ok === true, 'render should pass');
  assert.ok(out.payload.manifest && out.payload.manifest.manifest_id, 'manifest should be present');
  assert.ok(typeof out.payload.svg === 'string' && out.payload.svg.includes('<svg'), 'svg payload should be present');

  const manifestDir = path.join(tmp, 'state', 'identity', 'visual_signature', 'manifests');
  const manifestFiles = fs.readdirSync(manifestDir).filter((name) => name.endsWith('.json'));
  const svgFiles = fs.readdirSync(manifestDir).filter((name) => name.endsWith('.svg'));
  assert.ok(manifestFiles.length >= 1, 'manifest file should exist');
  assert.ok(svgFiles.length >= 1, 'svg file should exist');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('visual_signature_engine.test.js: OK');
} catch (err) {
  console.error(`visual_signature_engine.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
