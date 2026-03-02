#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'science', 'reasoning_mirror.js');

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function run(args, env) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8'
  });
}

function parseJson(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const lines = text.split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reasoning-mirror-'));
  const policyPath = path.join(tmp, 'config', 'reasoning_mirror_policy.json');
  const forgePath = path.join(tmp, 'state', 'science', 'hypothesis_forge', 'latest.json');
  const loopPath = path.join(tmp, 'state', 'science', 'loop', 'latest.json');
  const latestPath = path.join(tmp, 'state', 'science', 'reasoning_mirror', 'latest.json');
  const historyPath = path.join(tmp, 'state', 'science', 'reasoning_mirror', 'history.jsonl');
  const uiPath = path.join(tmp, 'state', 'science', 'reasoning_mirror', 'ui_contract.json');

  writeJson(forgePath, {
    top_hypothesis: {
      id: 'h_rev_1',
      text: 'If pricing increases, conversion falls',
      score: 0.74,
      rank_receipt_id: 'hyp_rank_abc'
    }
  });

  writeJson(loopPath, {
    receipt_id: 'sci_rcpt_123',
    steps: [
      { id: 'experiment', output: { experiment_defined: true } },
      { id: 'analyze', output: { effect_size: 0.18, p_value: 0.02, sample_size: 240 } },
      { id: 'conclude', output: { evidence_strength: 'strong' } },
      { id: 'iterate', output: { next_experiment: 'replicate_with_new_sample' } }
    ]
  });

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    paths: {
      hypothesis_latest_path: forgePath,
      loop_latest_path: loopPath,
      latest_path: latestPath,
      history_path: historyPath,
      ui_contract_path: uiPath
    }
  });

  const env = {
    REASONING_MIRROR_ROOT: tmp,
    REASONING_MIRROR_POLICY_PATH: policyPath
  };

  let out = run(['render'], env);
  assert.strictEqual(out.status, 0, out.stderr || 'render should pass');
  let payload = parseJson(out.stdout);
  assert.ok(payload && payload.ok === true, 'render payload should be ok');
  const c = payload.contract;
  assert.ok(c && c.active_hypothesis && c.active_hypothesis.id === 'h_rev_1', 'active hypothesis missing');
  assert.ok(c.confidence_interval && typeof c.confidence_interval.low === 'number', 'confidence interval missing');
  assert.ok(c.evidence_strength, 'evidence strength missing');
  assert.ok(c.key_statistical_outputs && typeof c.key_statistical_outputs.p_value === 'number', 'statistical outputs missing');
  assert.ok(typeof c.disconfirming_tests_run === 'number', 'disconfirming tests count missing');
  assert.ok(c.next_experiment_suggestion, 'next experiment suggestion missing');
  assert.ok(Array.isArray(c.receipt_linkage.source_receipt_ids) && c.receipt_linkage.source_receipt_ids.length >= 1, 'receipt linkage missing');
  assert.ok(fs.existsSync(uiPath), 'UI contract should be written');

  out = run(['status'], env);
  assert.strictEqual(out.status, 0, out.stderr || 'status should pass');
  payload = parseJson(out.stdout);
  assert.ok(payload && payload.ok === true, 'status payload should be ok');

  console.log('reasoning_mirror.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`reasoning_mirror.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
