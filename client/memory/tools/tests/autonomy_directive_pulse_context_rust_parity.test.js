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

function normalizeObjectives(items) {
  return (Array.isArray(items) ? items : [])
    .map((row) => {
      const obj = row && typeof row === 'object' ? row : {};
      return {
        id: String(obj.id || ''),
        tier: Number(obj.tier || 0),
        phrases: (Array.isArray(obj.phrases) ? obj.phrases : []).map((v) => String(v)),
        tokens: (Array.isArray(obj.tokens) ? obj.tokens : []).map((v) => String(v))
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

function normalizeObjectiveStats(statsRaw) {
  const map = statsRaw instanceof Map ? statsRaw : new Map();
  const out = [];
  for (const [objectiveId, statRaw] of map.entries()) {
    const stat = statRaw && typeof statRaw === 'object' ? statRaw : {};
    out.push({
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
  out.sort((a, b) => a.objective_id.localeCompare(b.objective_id));
  return out;
}

function normalize(ctxRaw) {
  const ctx = ctxRaw && typeof ctxRaw === 'object' ? ctxRaw : {};
  const byTier = ctx.tier_attempts_today && typeof ctx.tier_attempts_today === 'object'
    ? ctx.tier_attempts_today
    : {};
  return {
    enabled: ctx.enabled === true,
    available: ctx.available === true,
    error: ctx.error ? String(ctx.error) : null,
    window_days: Number(ctx.window_days || 0),
    urgency_hours: Number(ctx.urgency_hours || 0),
    no_progress_limit: Number(ctx.no_progress_limit || 0),
    cooldown_hours: Number(ctx.cooldown_hours || 0),
    attempts_today: Number(ctx.attempts_today || 0),
    tier_attempts_today: Object.keys(byTier)
      .sort()
      .map((key) => [key, Number(byTier[key] || 0)]),
    objectives: normalizeObjectives(ctx.objectives),
    objective_stats: normalizeObjectiveStats(ctx.objective_stats)
  };
}

function run() {
  const ts = loadAutonomy(false);
  const rust = loadAutonomy(true);

  const dateStr = '2026-03-04';
  const tsOut = normalize(ts.buildDirectivePulseContext(dateStr));
  const rustOut = normalize(rust.buildDirectivePulseContext(dateStr));

  assert.deepStrictEqual(rustOut, tsOut, 'buildDirectivePulseContext mismatch');
  console.log('autonomy_directive_pulse_context_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_directive_pulse_context_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
