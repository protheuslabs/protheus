#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'autonomy', 'dream_signal_bridge.js');

function writeText(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text, 'utf8');
}

function writeJson(filePath, payload) {
  writeText(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

function appendJsonl(filePath, row) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dream-signal-bridge-'));
  const policyPath = path.join(tmp, 'config', 'dream_signal_bridge_policy.json');
  const dreamsPath = path.join(tmp, 'state', 'memory', 'dreams');
  const proposalsPath = path.join(tmp, 'state', 'autonomy', 'dream_signal_bridge', 'proposals.jsonl');
  const date = '2026-03-02';

  writeJson(path.join(dreamsPath, `${date}.json`), {
    quality_score: 0.7,
    tokens: ['revenue', 'automation']
  });
  writeJson(path.join(dreamsPath, 'rem', `${date}.json`), {
    quality_score: 0.8,
    tokens: ['pipeline']
  });

  appendJsonl(proposalsPath, {
    proposal_id: 'P1',
    title: 'Revenue automation workflow',
    summary: 'Create an automation pipeline to increase revenue.',
    score: 5
  });
  appendJsonl(proposalsPath, {
    proposal_id: 'P2',
    title: 'UI spacing cleanup',
    summary: 'Polish margins and colors.',
    score: 6
  });

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    dreams_path: dreamsPath,
    proposals_path: proposalsPath,
    min_quality_score: 0.2,
    max_alignment_bonus: 6,
    outputs: {
      latest_path: path.join(tmp, 'state', 'autonomy', 'dream_signal_bridge', 'latest.json'),
      history_path: path.join(tmp, 'state', 'autonomy', 'dream_signal_bridge', 'history.jsonl'),
      enriched_output_path: path.join(tmp, 'state', 'autonomy', 'dream_signal_bridge', 'enriched.json')
    }
  });

  const env = {
    DREAM_SIGNAL_BRIDGE_ROOT: tmp,
    DREAM_SIGNAL_BRIDGE_POLICY_PATH: policyPath
  };

  const r = run(['run', `--date=${date}`, '--apply=1', '--strict=1'], env);
  assert.strictEqual(r.status, 0, r.stderr || 'bridge run should pass');
  const out = parseJson(r.stdout);
  assert.ok(out && out.ok === true, 'payload should pass');
  assert.strictEqual(Number(out.attribution.dream_hit_count || 0), 1, 'one proposal should be dream hit');
  assert.ok(Array.isArray(out.top_ranked) && out.top_ranked[0].proposal_id === 'P1', 'dream-aligned proposal should rank first');

  console.log('dream_signal_bridge.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`dream_signal_bridge.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
