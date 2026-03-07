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

function normalizeSelection(result) {
  const src = result && typeof result === 'object' ? result : {};
  const canaryEvery = src.canary_every == null ? null : Number(src.canary_every);
  return {
    strategy_id: src.strategy && src.strategy.id ? String(src.strategy.id) : null,
    mode: String(src.mode || ''),
    canary_enabled: src.canary_enabled === true,
    canary_due: src.canary_due === true,
    canary_every: !Number.isFinite(canaryEvery) || canaryEvery <= 0 ? null : canaryEvery,
    attempt_index: Number(src.attempt_index || 0),
    active_count: Number(src.active_count || 0),
    ranked: (Array.isArray(src.ranked) ? src.ranked : []).map((row) => ({
      strategy_id: String(row && row.strategy_id || ''),
      score: Number(row && row.score || 0),
      confidence: Number(row && row.confidence || 0),
      stage: row && row.stage ? String(row.stage) : null,
      execution_mode: String(row && row.execution_mode || '')
    }))
  };
}

function run() {
  const ts = loadAutonomy(false);
  const rust = loadAutonomy(true);

  const scenarios = [
    [],
    [{ type: 'autonomy_run', ts: '2026-03-04T00:00:00.000Z' }],
    [
      { type: 'autonomy_run', ts: '2026-03-04T00:00:00.000Z' },
      { type: 'autonomy_run', ts: '2026-03-04T00:05:00.000Z' },
      { type: 'autonomy_run', ts: '2026-03-04T00:10:00.000Z' }
    ]
  ];

  for (const priorRuns of scenarios) {
    const tsOut = normalizeSelection(ts.selectStrategyForRun('2026-03-04', priorRuns));
    const rustOut = normalizeSelection(rust.selectStrategyForRun('2026-03-04', priorRuns));
    assert.deepStrictEqual(
      rustOut,
      tsOut,
      `selectStrategyForRun mismatch for priorRuns=${priorRuns.length}`
    );
  }

  console.log('autonomy_strategy_selection_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_strategy_selection_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
