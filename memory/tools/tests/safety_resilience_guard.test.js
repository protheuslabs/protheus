#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function parseJson(stdout) {
  const raw = String(stdout || '').trim();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch {}
  const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function runEval(script, root, policyPath, sentinel, signals) {
  const result = spawnSync(process.execPath, [
    script,
    'evaluate',
    `--policy=${policyPath}`,
    `--sentinel-json=${JSON.stringify(sentinel)}`,
    `--signals-json=${JSON.stringify(signals)}`,
    '--apply=1'
  ], {
    cwd: root,
    encoding: 'utf8'
  });
  assert.strictEqual(result.status, 0, result.stderr || 'evaluation command should pass');
  return parseJson(result.stdout);
}

function main() {
  const root = path.resolve(__dirname, '..', '..', '..');
  const script = path.join(root, 'systems', 'security', 'safety_resilience_guard.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'safety-resilience-'));

  const policyPath = path.join(tmp, 'policy.json');
  writeJson(policyPath, {
    schema_id: 'safety_resilience_policy',
    schema_version: '1.0',
    enabled: true,
    anti_spam: {
      window_minutes: 60,
      max_alerts_per_window: 10,
      max_identical_reason_burst: 10,
      cooldown_minutes: 1
    },
    consensus: {
      min_independent_signals_for_confirmed_malice: 2,
      signal_keys: ['strand_mismatch', 'codex_failure', 'codex_signature_mismatch']
    },
    false_positive: {
      max_daily_downgrades: 1,
      enforce_budget_guard: true,
      extra_signals_when_budget_exhausted: 1
    },
    state_path: path.join(tmp, 'state.json'),
    receipts_path: path.join(tmp, 'receipts.jsonl')
  });

  const weakSignals = { strand_mismatch: true };
  const strongSignals = { strand_mismatch: true, codex_failure: true };

  const first = runEval(script, root, policyPath, {
    tier: 'confirmed_malice',
    score: 4.4,
    reason_codes: ['sentinel_strand_mismatch']
  }, weakSignals);

  assert.strictEqual(first.tier_before, 'confirmed_malice');
  assert.strictEqual(first.tier_after, 'stasis', 'weak consensus should downgrade malice tier');
  assert.strictEqual(first.downgraded, true, 'first run should downgrade');
  assert.ok(Array.isArray(first.guard_reasons) && first.guard_reasons.includes('consensus_not_met_for_malice'));

  const second = runEval(script, root, policyPath, {
    tier: 'confirmed_malice',
    score: 4.4,
    reason_codes: ['sentinel_strand_mismatch', 'sentinel_codex_verification_failed']
  }, strongSignals);

  assert.strictEqual(second.budget_exhausted, true, 'false-positive downgrade budget should now be exhausted');
  assert.strictEqual(second.tier_after, 'stasis', 'budget guard should keep high tier dampened when extra consensus is not met');
  assert.ok(Array.isArray(second.guard_reasons) && second.guard_reasons.includes('false_positive_budget_guard'));

  const receipts = fs.readFileSync(path.join(tmp, 'receipts.jsonl'), 'utf8').split('\n').filter(Boolean);
  assert.ok(receipts.length >= 2, 'expected resilience receipts to be written');

  console.log('safety_resilience_guard.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`safety_resilience_guard.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
