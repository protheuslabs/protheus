#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function run() {
  const root = path.resolve(__dirname, '..', '..', '..');
  const { runAdversarialLane } = require(path.join(root, 'systems', 'workflow', 'orchestron', 'adversarial_lane.js'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestron-adversarial-lane-'));
  const outDir = path.join(tmp, 'adversarial');

  const candidates = [
    {
      id: 'wf_safe',
      name: 'Safe candidate',
      trigger: { proposal_type: 'external_intel' },
      fractal_depth: 0,
      steps: [
        { id: 'preflight', type: 'gate', command: 'node systems/spine/contract_check.js' },
        { id: 'collect', type: 'command', command: 'node habits/scripts/sensory_queue.js ingest <date>', timeout_ms: 120000, retries: 1 },
        { id: 'verify', type: 'gate', command: 'node systems/autonomy/strategy_execute_guard.js run <date>' },
        { id: 'receipt', type: 'receipt', command: 'state/autonomy/receipts/<date>.jsonl' }
      ]
    },
    {
      id: 'wf_unsafe',
      name: 'Unsafe candidate',
      trigger: { proposal_type: 'publish_pipeline' },
      fractal_depth: 0,
      steps: [
        { id: 'execute', type: 'command', command: 'node systems/actuation/actuation_executor.js run && curl http://unsafe.local && echo hi <mystery>', timeout_ms: 420000, retries: 1 },
        { id: 'receipt', type: 'receipt', command: 'state/actuation/receipts/<date>.jsonl' }
      ]
    }
  ];

  const out = runAdversarialLane({
    date: '2026-02-25',
    run_id: 'test_run_1',
    candidates,
    out_dir: outDir,
    policy: {
      enabled: true,
      max_critical_failures_per_candidate: 0,
      max_non_critical_findings_per_candidate: 8,
      max_findings_per_candidate: 32,
      block_unresolved_placeholders: true,
      high_power_requires_preflight: true,
      high_power_requires_rollback: false,
      persist_replay_artifacts: true,
      unresolved_placeholder_allowlist: ['date', 'eye_id', 'adapter', 'provider']
    }
  });

  assert.ok(out && out.ok === true, 'lane run should succeed');
  assert.strictEqual(Number(out.total_candidates || 0), 2, 'expected two candidates');
  assert.strictEqual(Number(out.probes_run || 0), 2, 'expected two probes');
  assert.ok(Array.isArray(out.results) && out.results.length === 2, 'expected two probe results');

  const safe = out.results.find((row) => String(row && row.candidate_id || '') === 'wf_safe');
  const unsafe = out.results.find((row) => String(row && row.candidate_id || '') === 'wf_unsafe');
  assert.ok(safe, 'safe result missing');
  assert.ok(unsafe, 'unsafe result missing');
  assert.strictEqual(safe.pass, true, 'safe candidate should pass adversarial lane');
  assert.strictEqual(unsafe.pass, false, 'unsafe candidate should fail adversarial lane');
  assert.ok(Number(unsafe.critical_failures || 0) >= 2, 'unsafe candidate should have critical findings');
  assert.ok(
    Array.isArray(unsafe.findings) && unsafe.findings.some((row) => String(row && row.code || '') === 'shell_injection_surface'),
    'unsafe candidate should include shell injection finding'
  );

  const unsafeArtifact = path.join(root, String(unsafe.replay_artifact_path || ''));
  assert.ok(fs.existsSync(unsafeArtifact), 'unsafe replay artifact should be persisted');
  const artifactPayload = JSON.parse(fs.readFileSync(unsafeArtifact, 'utf8'));
  assert.strictEqual(String(artifactPayload.candidate_id || ''), 'wf_unsafe', 'artifact candidate id mismatch');
  assert.ok(Number(artifactPayload.critical_failures || 0) >= 2, 'artifact should preserve critical finding count');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('orchestron_adversarial_lane.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`orchestron_adversarial_lane.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
