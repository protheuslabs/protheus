#!/usr/bin/env node
'use strict';

const path = require('path');
const assert = require('assert');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const autonomyPath = path.join(REPO_ROOT, 'systems', 'autonomy', 'autonomy_controller.js');
const bridgePath = path.join(REPO_ROOT, 'systems', 'autonomy', 'backlog_autoscale_rust_bridge.js');

function loadAutonomy(rustEnabled) {
  process.env.AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED = rustEnabled ? '1' : '0';
  delete require.cache[autonomyPath];
  delete require.cache[bridgePath];
  return require(autonomyPath);
}

function normalizeOverlay(map) {
  return Array.from((map instanceof Map ? map : new Map()).entries()).map(([proposalId, row]) => [
    proposalId,
    {
      decision: row && row.decision ? String(row.decision) : null,
      decision_ts: row && row.decision_ts ? String(row.decision_ts) : null,
      decision_reason: row && row.decision_reason ? String(row.decision_reason) : null,
      last_outcome: row && row.last_outcome ? String(row.last_outcome) : null,
      last_outcome_ts: row && row.last_outcome_ts ? String(row.last_outcome_ts) : null,
      last_evidence_ref: row && row.last_evidence_ref ? String(row.last_evidence_ref) : null,
      outcomes: {
        shipped: Number(row && row.outcomes && row.outcomes.shipped || 0),
        reverted: Number(row && row.outcomes && row.outcomes.reverted || 0),
        no_change: Number(row && row.outcomes && row.outcomes.no_change || 0)
      }
    }
  ]);
}

function run() {
  const ts = loadAutonomy(false);
  const rust = loadAutonomy(true);

  const events = [
    { proposal_id: 'p-1', type: 'decision', decision: 'accept', ts: '2026-03-04T00:00:00.000Z', reason: 'first' },
    { proposal_id: 'p-2', type: 'decision', decision: 'accept', ts: '2026-03-04T00:01:00.000Z', reason: 'open' },
    { proposal_id: 'p-1', type: 'outcome', outcome: 'shipped', ts: '2026-03-04T00:02:00.000Z', evidence_ref: 'eye:ops' },
    { proposal_id: 'p-1', type: 'decision', decision: 'reject', ts: '2026-03-04T00:03:00.000Z', reason: 'latest' },
    { proposal_id: 'p-1', type: 'outcome', outcome: 'no_change', ts: '2026-03-04T00:04:00.000Z', evidence_ref: 'eye:ops2' }
  ];

  assert.deepStrictEqual(
    normalizeOverlay(rust.buildOverlay(events)),
    normalizeOverlay(ts.buildOverlay(events)),
    'buildOverlay mismatch'
  );

  const adaptiveSamples = [
    { type: 'adaptive_mutation', meta: {} },
    { type: 'other', meta: { adaptive_mutation: true } },
    { type: 'other', meta: {}, action_spec: { kind: 'mutation_guard' }, summary: 'mutation rollback' },
    { type: 'other', meta: {}, action_spec: { kind: 'noop' } }
  ];
  for (const sample of adaptiveSamples) {
    assert.strictEqual(
      rust.hasAdaptiveMutationSignal(sample),
      ts.hasAdaptiveMutationSignal(sample),
      `hasAdaptiveMutationSignal mismatch for ${JSON.stringify(sample)}`
    );
  }

  const guardSamples = [
    {
      type: 'adaptive_mutation',
      meta: {
        adaptive_mutation_guard_applies: true,
        adaptive_mutation_guard_pass: true,
        safety_attestation_id: 'safe-1',
        rollback_receipt_id: 'roll-1',
        adaptive_mutation_guard_receipt_id: 'guard-1'
      }
    },
    {
      type: 'adaptive_mutation',
      meta: {
        adaptive_mutation_guard_applies: true,
        adaptive_mutation_guard_pass: false,
        adaptive_mutation_guard_reason: 'guard_failed',
        adaptive_mutation_guard_controls: {
          mutation_kernel_applies: true,
          mutation_kernel_pass: false
        }
      }
    },
    {
      type: 'other',
      meta: {}
    }
  ];

  for (const sample of guardSamples) {
    assert.deepStrictEqual(
      rust.adaptiveMutationExecutionGuardDecision(sample),
      ts.adaptiveMutationExecutionGuardDecision(sample),
      `adaptiveMutationExecutionGuardDecision mismatch for ${JSON.stringify(sample)}`
    );
  }

  console.log('autonomy_adaptive_overlay_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_adaptive_overlay_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
