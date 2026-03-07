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

function normalizeObjectiveStats(statsRaw) {
  const statsMap = statsRaw instanceof Map ? statsRaw : new Map();
  const rows = [];
  for (const [objectiveId, statRaw] of statsMap.entries()) {
    const stat = statRaw && typeof statRaw === 'object' ? statRaw : {};
    rows.push({
      objective_id: String(objectiveId || stat.objective_id || ''),
      tier: Number(stat.tier || 0),
      attempts: Number(stat.attempts || 0),
      shipped: Number(stat.shipped || 0),
      no_change: Number(stat.no_change || 0),
      reverted: Number(stat.reverted || 0),
      no_progress_streak: Number(stat.no_progress_streak || 0),
      last_attempt_ts: stat.last_attempt_ts ? String(stat.last_attempt_ts) : null,
      last_shipped_ts: stat.last_shipped_ts ? String(stat.last_shipped_ts) : null
    });
  }
  rows.sort((a, b) => a.objective_id.localeCompare(b.objective_id));
  return rows;
}

function normalizeStats(statsRaw) {
  const stats = statsRaw && typeof statsRaw === 'object' ? statsRaw : {};
  const tierAttempts = stats.tier_attempts_today && typeof stats.tier_attempts_today === 'object'
    ? stats.tier_attempts_today
    : {};
  return {
    attempts_today: Number(stats.attempts_today || 0),
    tier_attempts_today: Object.keys(tierAttempts)
      .sort()
      .map((key) => [key, Number(tierAttempts[key] || 0)]),
    objective_stats: normalizeObjectiveStats(stats.stats)
  };
}

function run() {
  const ts = loadAutonomy(false);
  const rust = loadAutonomy(true);

  const dateStr = '2026-03-04';
  const days = 14;
  const tsOut = normalizeStats(ts.buildDirectivePulseStats(dateStr, days));
  const rustOut = normalizeStats(rust.buildDirectivePulseStats(dateStr, days));

  assert.deepStrictEqual(rustOut, tsOut, 'buildDirectivePulseStats mismatch');
  console.log('autonomy_directive_pulse_stats_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_directive_pulse_stats_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
