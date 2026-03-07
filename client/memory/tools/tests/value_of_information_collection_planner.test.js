#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'sensory', 'value_of_information_collection_planner.js');

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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'voi-planner-'));
  const dateStr = '2026-03-02';
  const abstainDir = path.join(tmp, 'state', 'sensory', 'analysis', 'abstain_uncertainty');
  const chainDir = path.join(tmp, 'state', 'sensory', 'analysis', 'objective_chain_mapper');
  const outDir = path.join(tmp, 'state', 'sensory', 'analysis', 'value_information_planner');
  const policyPath = path.join(tmp, 'config', 'value_of_information_collection_planner_policy.json');

  writeJson(path.join(abstainDir, `${dateStr}.json`), {
    abstained: [
      { topic: 'revenue', resolved: false },
      { topic: 'revenue', resolved: false },
      { topic: 'infrastructure', resolved: true }
    ]
  });

  writeJson(path.join(chainDir, `${dateStr}.json`), {
    chains: [
      { topic: 'revenue', objective_id: 'T1_make_jay_billionaire_v1', path_confidence: 0.88 },
      { topic: 'infrastructure', objective_id: 'T1_generational_wealth_v1', path_confidence: 0.66 }
    ]
  });

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    max_actions: 5,
    min_expected_information_gain: 0.05,
    objective_weights: {
      T1_make_jay_billionaire_v1: 1,
      T1_generational_wealth_v1: 0.9
    },
    uncertainty_weights: {
      abstain_count: 0.6,
      unresolved_abstain_rate: 0.4
    },
    paths: {
      abstain_dir: abstainDir,
      chain_mapper_dir: chainDir,
      output_dir: outDir,
      latest_path: path.join(outDir, 'latest.json'),
      receipts_path: path.join(outDir, 'receipts.jsonl')
    }
  });

  let out = run(['run', dateStr, '--strict=1', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.type === 'value_of_information_collection_planner', 'run should produce planner output');
  assert.ok(Number(out.payload.plan_count || 0) >= 1, 'planner should emit at least one action');
  assert.ok(Array.isArray(out.payload.actions) && out.payload.actions[0].expected_information_gain >= out.payload.actions[out.payload.actions.length - 1].expected_information_gain, 'actions should be ranked by expected information gain');

  const top = out.payload.actions[0];
  assert.strictEqual(top.topic, 'revenue', 'highest uncertainty+impact topic should rank first');

  out = run(['status', dateStr, `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.type === 'value_of_information_collection_planner', 'status should read output');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('value_of_information_collection_planner.test.js: OK');
} catch (err) {
  console.error(`value_of_information_collection_planner.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
