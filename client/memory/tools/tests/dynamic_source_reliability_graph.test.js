#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'sensory', 'dynamic_source_reliability_graph.js');

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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'source-reliability-'));
  const dateStr = '2026-03-02';
  const hypothesesDir = path.join(tmp, 'state', 'sensory', 'cross_signal', 'hypotheses');
  const outcomesDir = path.join(tmp, 'state', 'sensory', 'analysis', 'hypothesis_outcomes');
  const outDir = path.join(tmp, 'state', 'sensory', 'analysis', 'source_reliability');
  const policyPath = path.join(tmp, 'config', 'dynamic_source_reliability_graph_policy.json');

  writeJson(path.join(hypothesesDir, `${dateStr}.json`), {
    hypotheses: [
      {
        id: 'h1',
        evidence: [
          { eye_id: 'reddit_ai_agents' },
          { eye_id: 'google_trends' }
        ]
      },
      {
        id: 'h2',
        evidence: [
          { eye_id: 'reddit_ai_agents' }
        ]
      }
    ]
  });

  writeJson(path.join(outcomesDir, `${dateStr}.json`), {
    outcomes: [
      { hypothesis_id: 'h1', outcome: 'true_positive' },
      { hypothesis_id: 'h2', outcome: 'false_positive' }
    ]
  });

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    neutral_score: 0.5,
    min_score: 0.05,
    max_score: 0.95,
    learning_rate: 0.2,
    decay_toward_neutral: 0.03,
    per_event_influence_cap: 0.12,
    positive_outcomes: ['true_positive'],
    negative_outcomes: ['false_positive'],
    paths: {
      hypotheses_dir: hypothesesDir,
      outcomes_dir: outcomesDir,
      state_path: path.join(outDir, 'state.json'),
      output_dir: outDir,
      latest_path: path.join(outDir, 'latest.json'),
      receipts_path: path.join(outDir, 'receipts.jsonl')
    }
  });

  let out = run(['run', dateStr, '--strict=1', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.type === 'dynamic_source_reliability_graph', 'run should produce reliability output');
  assert.ok(Number(out.payload.source_count || 0) >= 2, 'two sources should be tracked');

  const sources = out.payload.sources || [];
  const reddit = sources.find((row) => row.source_id === 'reddit_ai_agents');
  const trends = sources.find((row) => row.source_id === 'google_trends');
  assert.ok(reddit, 'reddit source should exist');
  assert.ok(trends, 'google trends source should exist');
  assert.ok(Number(reddit.score || 0) >= 0.05 && Number(reddit.score || 0) <= 0.95, 'reddit score should respect bounds');
  assert.ok(Number(trends.score || 0) >= 0.05 && Number(trends.score || 0) <= 0.95, 'trends score should respect bounds');

  out = run(['status', dateStr, `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.type === 'dynamic_source_reliability_graph', 'status should read output');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('dynamic_source_reliability_graph.test.js: OK');
} catch (err) {
  console.error(`dynamic_source_reliability_graph.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
