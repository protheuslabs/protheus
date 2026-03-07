#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'sensory', 'multi_hop_objective_chain_mapper.js');

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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'objective-chain-'));
  const policyPath = path.join(tmp, 'config', 'multi_hop_objective_chain_policy.json');
  const hypothesesDir = path.join(tmp, 'state', 'sensory', 'cross_signal', 'hypotheses');
  const latentDir = path.join(tmp, 'state', 'sensory', 'analysis', 'latent_intent');
  const outputDir = path.join(tmp, 'state', 'sensory', 'analysis', 'objective_chain_mapper');
  const dateStr = '2026-03-02';

  writeJson(path.join(hypothesesDir, `${dateStr}.json`), {
    type: 'cross_signal_hypotheses',
    date: dateStr,
    hypotheses: [
      {
        id: 'h_rev',
        type: 'convergence',
        topic: 'revenue',
        confidence: 92,
        probability: 0.91,
        support_events: 11,
        evidence: [
          { eye_id: 'reddit_ai_agents', title: 'pricing pressure discussion' },
          { eye_id: 'google_trends', title: 'revenue growth spike' }
        ]
      }
    ]
  });

  writeJson(path.join(latentDir, `${dateStr}.json`), {
    type: 'latent_intent_inference_graph',
    date: dateStr,
    edges: [
      {
        edge_id: 'imp_1',
        source_hypothesis_id: 'h_rev',
        topic: 'revenue',
        implied_need: 'pricing_experiment_plan',
        probability: 0.87,
        source_confidence: 92,
        source_probability: 0.91,
        evidence_spans: [
          { eye_id: 'reddit_ai_agents', title: 'pricing signals' }
        ]
      }
    ]
  });

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    min_path_confidence: 0.58,
    max_paths_per_objective: 10,
    max_paths_total: 100,
    objective_weights: {
      T1_make_jay_billionaire_v1: 1,
      T1_generational_wealth_v1: 0.8
    },
    objective_hints: {
      T1_make_jay_billionaire_v1: ['revenue', 'pricing', 'growth'],
      T1_generational_wealth_v1: ['wealth', 'compounding', 'equity']
    },
    paths: {
      hypotheses_dir: hypothesesDir,
      latent_intent_dir: latentDir,
      output_dir: outputDir,
      latest_path: path.join(outputDir, 'latest.json'),
      receipts_path: path.join(outputDir, 'receipts.jsonl')
    }
  });

  let out = run(['run', dateStr, '--strict=1', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.type === 'multi_hop_objective_chain_mapper', 'run should produce mapper output');
  assert.ok(Number(out.payload.chain_count || 0) >= 1, 'should emit at least one chain');
  assert.strictEqual(out.payload.ranking_receipt.blocked, false, 'should not block when chains exist');

  const top = out.payload.chains[0];
  assert.ok(top && Array.isArray(top.hops) && top.hops.length === 4, 'top path should have 4-hop chain');
  assert.strictEqual(top.hops[0].kind, 'eye');
  assert.strictEqual(top.hops[1].kind, 'topic');
  assert.strictEqual(top.hops[2].kind, 'implication');
  assert.strictEqual(top.hops[3].kind, 'objective');
  assert.strictEqual(top.objective_id, 'T1_make_jay_billionaire_v1', 'revenue/pricing chain should prioritize T1 objective');

  out = run(['status', dateStr, `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.type === 'multi_hop_objective_chain_mapper', 'status should read output');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('multi_hop_objective_chain_mapper.test.js: OK');
} catch (err) {
  console.error(`multi_hop_objective_chain_mapper.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
