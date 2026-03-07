#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'sensory', 'causal_vs_correlation_signal_scorer.js');

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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'causal-scorer-'));
  const dateStr = '2026-03-02';
  const chainDir = path.join(tmp, 'state', 'sensory', 'analysis', 'objective_chain_mapper');
  const counterfactualDir = path.join(tmp, 'state', 'sensory', 'analysis', 'counterfactual_replay');
  const reliabilityDir = path.join(tmp, 'state', 'sensory', 'analysis', 'source_reliability');
  const outDir = path.join(tmp, 'state', 'sensory', 'analysis', 'causal_signal_scorer');
  const policyPath = path.join(tmp, 'config', 'causal_vs_correlation_signal_scorer_policy.json');

  writeJson(path.join(chainDir, `${dateStr}.json`), {
    chains: [
      { path_id: 'p1', eye_id: 'reddit_ai_agents', objective_id: 'T1_make_jay_billionaire_v1', path_confidence: 0.82, hops: [{}, {}, {}, {}] },
      { path_id: 'p2', eye_id: 'unknown_eye', objective_id: 'T1_generational_wealth_v1', path_confidence: 0.28, hops: [{}] }
    ]
  });

  writeJson(path.join(counterfactualDir, `${dateStr}.json`), {
    deltas: {
      precision_uplift: 0.08,
      recall_uplift: 0.05
    }
  });

  writeJson(path.join(reliabilityDir, 'latest.json'), {
    sources: [
      { source_id: 'reddit_ai_agents', score: 0.79 }
    ]
  });

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    min_causal_score: 0.58,
    max_correlation_penalty: 0.22,
    weights: {
      chain_confidence: 0.42,
      counterfactual_uplift: 0.28,
      source_reliability: 0.2,
      structure_bonus: 0.1
    },
    paths: {
      chain_mapper_dir: chainDir,
      counterfactual_dir: counterfactualDir,
      source_reliability_latest: path.join(reliabilityDir, 'latest.json'),
      output_dir: outDir,
      latest_path: path.join(outDir, 'latest.json'),
      receipts_path: path.join(outDir, 'receipts.jsonl')
    }
  });

  let out = run(['run', dateStr, '--strict=1', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.type === 'causal_vs_correlation_signal_scorer', 'run should produce scorer output');
  assert.strictEqual(Number(out.payload.chain_count || 0), 2, 'two chain rows should be scored');
  assert.ok(Number(out.payload.penalized_count || 0) >= 1, 'low-causal chain should be penalized');
  assert.ok(Array.isArray(out.payload.rankings) && out.payload.rankings[0].final_score >= out.payload.rankings[1].final_score, 'rankings should be sorted by final score');

  out = run(['status', dateStr, `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.type === 'causal_vs_correlation_signal_scorer', 'status should read output');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('causal_vs_correlation_signal_scorer.test.js: OK');
} catch (err) {
  console.error(`causal_vs_correlation_signal_scorer.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
