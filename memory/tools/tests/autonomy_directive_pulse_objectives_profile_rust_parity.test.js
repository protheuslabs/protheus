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

function normalizeObjectives(rowsRaw) {
  return (Array.isArray(rowsRaw) ? rowsRaw : [])
    .map((rowRaw) => {
      const row = rowRaw && typeof rowRaw === 'object' ? rowRaw : {};
      return {
        id: String(row.id || ''),
        tier: Number(row.tier || 0),
        title: String(row.title || ''),
        tier_weight: Number(row.tier_weight || 0),
        min_share: Number(row.min_share || 0),
        phrases: (Array.isArray(row.phrases) ? row.phrases : []).map((v) => String(v || '')).sort(),
        tokens: (Array.isArray(row.tokens) ? row.tokens : []).map((v) => String(v || '')).sort(),
        value_currencies: (Array.isArray(row.value_currencies) ? row.value_currencies : [])
          .map((v) => String(v || ''))
          .sort(),
        primary_currency: row.primary_currency ? String(row.primary_currency) : null
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

function normalizeProfile(raw) {
  const profile = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: profile.enabled === true,
    available: profile.available === true,
    error: profile.error ? String(profile.error) : null,
    objectives: normalizeObjectives(profile.objectives)
  };
}

function run() {
  const ts = loadAutonomy(false);
  const rust = loadAutonomy(true);

  const tsOut = normalizeProfile(ts.loadDirectivePulseObjectives());
  const rustOut = normalizeProfile(rust.loadDirectivePulseObjectives());
  assert.deepStrictEqual(rustOut, tsOut, 'loadDirectivePulseObjectives mismatch');

  console.log('autonomy_directive_pulse_objectives_profile_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_directive_pulse_objectives_profile_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
