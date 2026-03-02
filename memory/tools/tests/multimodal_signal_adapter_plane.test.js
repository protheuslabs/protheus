#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'sensory', 'multimodal_signal_adapter_plane.js');

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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'multimodal-adapter-'));
  const dateStr = '2026-03-02';
  const repoDir = path.join(tmp, 'state', 'sensory', 'non_text', 'repo_activity');
  const imageDir = path.join(tmp, 'state', 'sensory', 'non_text', 'image_signal');
  const marketDir = path.join(tmp, 'state', 'sensory', 'non_text', 'market_micro');
  const outDir = path.join(tmp, 'state', 'sensory', 'analysis', 'multimodal_adapter');
  const policyPath = path.join(tmp, 'config', 'multimodal_signal_adapter_policy.json');

  writeJson(path.join(repoDir, `${dateStr}.json`), {
    source_type: 'repo_activity',
    source_id: 'github_protheus',
    features: [
      { key: 'commit_velocity', signal: 0.9, confidence: 0.8, weight: 0.24 },
      { key: 'issue_burst', signal: 0.4, confidence: 0.7 }
    ]
  });
  writeJson(path.join(imageDir, `${dateStr}.json`), {
    source_type: 'image_signal',
    source_id: 'screenshots_lane',
    features: [
      { key: 'diagram_complexity', signal: 0.3, confidence: 0.6, weight: 0.15 }
    ]
  });
  writeJson(path.join(marketDir, `${dateStr}.json`), {
    source_type: 'market_micro',
    source_id: 'trend_feed',
    features: [
      { key: 'search_spike', signal: 0.7, confidence: 0.9, weight: 0.22 }
    ]
  });

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    max_feature_weight: 0.35,
    default_source_weight: 0.2,
    source_weights: {
      repo_activity: 0.24,
      image_signal: 0.18,
      market_micro: 0.22
    },
    required_sources: ['repo_activity'],
    paths: {
      repo_activity_dir: repoDir,
      image_signal_dir: imageDir,
      market_micro_dir: marketDir,
      output_dir: outDir,
      latest_path: path.join(outDir, 'latest.json'),
      receipts_path: path.join(outDir, 'receipts.jsonl')
    }
  });

  let out = run(['run', dateStr, '--strict=1', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.type === 'multimodal_signal_adapter_plane', 'run should produce adapter output');
  assert.ok(Number(out.payload.feature_count || 0) >= 4, 'all non-text features should be normalized');
  assert.strictEqual(out.payload.ok, true, 'required source should be satisfied');
  for (const row of out.payload.adapters || []) {
    assert.ok(Math.abs(Number(row.bounded_influence || 0)) <= 0.35 + 1e-9, 'influence should stay within bounded weight');
  }

  out = run(['status', dateStr, `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.type === 'multimodal_signal_adapter_plane', 'status should read output');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('multimodal_signal_adapter_plane.test.js: OK');
} catch (err) {
  console.error(`multimodal_signal_adapter_plane.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
