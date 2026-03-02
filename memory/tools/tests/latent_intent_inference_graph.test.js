#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'sensory', 'latent_intent_inference_graph.js');

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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'latent-intent-'));
  const policyPath = path.join(tmp, 'config', 'latent_intent_inference_policy.json');
  const hypothesesDir = path.join(tmp, 'state', 'sensory', 'cross_signal', 'hypotheses');
  const outputDir = path.join(tmp, 'state', 'sensory', 'analysis', 'latent_intent');
  const dateStr = '2026-03-02';

  writeJson(path.join(hypothesesDir, `${dateStr}.json`), {
    type: 'cross_signal_hypotheses',
    date: dateStr,
    hypotheses: [
      {
        id: 'h1',
        type: 'convergence',
        topic: 'revenue',
        confidence: 88,
        probability: 0.82,
        support_events: 7,
        evidence: [{ eye_id: 'eye_a', title: 'revenue automation bottleneck' }]
      },
      {
        id: 'h2',
        type: 'negative_signal',
        topic: 'automation',
        confidence: 77,
        probability: 0.74,
        support_events: 2,
        evidence: [{ eye_id: 'eye_b', title: 'automation failed rollout' }]
      },
      {
        id: 'h3',
        type: 'convergence',
        topic: 'infrastructure',
        confidence: 91,
        probability: 0.9,
        support_events: 9,
        evidence: [{ eye_id: 'eye_c', title: 'infrastructure scaling demand' }]
      }
    ]
  });

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    min_source_confidence: 60,
    max_edges_per_topic: 3,
    validator: {
      false_positive_ceiling: 0.5,
      min_support_events: 3
    },
    rules: [
      { topic_contains: 'revenue', implied_need: 'pricing_experiment_plan', weight: 0.8 },
      { topic_contains: 'automation', implied_need: 'workflow_auto_apply_candidate', weight: 0.76 },
      { topic_contains: 'infrastructure', implied_need: 'resilience_upgrade_backlog', weight: 0.72 }
    ],
    paths: {
      hypotheses_dir: hypothesesDir,
      output_dir: outputDir,
      latest_path: path.join(outputDir, 'latest.json'),
      receipts_path: path.join(outputDir, 'receipts.jsonl')
    }
  });

  let out = run(['run', dateStr, `--policy=${policyPath}`, '--strict=1']);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.ok === true, 'run should pass');
  assert.ok(Array.isArray(out.payload.edges) && out.payload.edges.length >= 2, 'expected inferred edges');
  const implied = out.payload.edges.find((row) => row.implied_need === 'pricing_experiment_plan');
  assert.ok(implied, 'expected pricing implied need');
  assert.ok(Array.isArray(implied.evidence_spans) && implied.evidence_spans.length >= 1, 'expected evidence spans');
  assert.ok(out.payload.validator && out.payload.validator.pass === true, 'validator should pass');

  out = run(['status', dateStr, `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.type === 'latent_intent_inference_graph', 'status should load output');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('latent_intent_inference_graph.test.js: OK');
} catch (err) {
  console.error(`latent_intent_inference_graph.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
