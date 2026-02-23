#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');

function run() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const mod = require(path.join(repoRoot, 'habits', 'scripts', 'external_eyes.js'));

  assert.strictEqual(typeof mod.collectRegistryDarkCandidates, 'function');
  assert.strictEqual(typeof mod.mergeSelfHealCandidates, 'function');

  const nowMs = Date.parse('2026-02-22T12:00:00.000Z');
  const config = {
    eyes: [
      { id: 'a', parser_type: 'hn_rss', status: 'active', cadence_hours: 4 },
      { id: 'b', parser_type: 'moltbook_hot', status: 'probation', cadence_hours: 4 },
      { id: 'c', parser_type: 'bird_x', status: 'active', cadence_hours: 4 },
      { id: 'stub_eye', parser_type: 'stub', status: 'active', cadence_hours: 1 },
      { id: 'retired_eye', parser_type: 'hn_rss', status: 'retired', cadence_hours: 4 }
    ]
  };
  const registry = {
    eyes: [
      {
        id: 'a',
        last_success: '2026-02-21T06:00:00.000Z',
        consecutive_failures: 2,
        consecutive_no_signal_runs: 0,
        self_heal_attempts: 0,
        self_heal_recoveries: 0
      },
      {
        id: 'b',
        last_real_signal_ts: '2026-02-21T02:00:00.000Z',
        consecutive_failures: 0,
        consecutive_no_signal_runs: 3,
        self_heal_attempts: 1,
        self_heal_recoveries: 0
      },
      {
        id: 'c',
        last_success: '2026-02-22T08:00:00.000Z',
        consecutive_failures: 3,
        consecutive_no_signal_runs: 0
      },
      {
        id: 'stub_eye',
        last_success: '2026-02-21T00:00:00.000Z',
        consecutive_failures: 5
      },
      {
        id: 'retired_eye',
        last_success: '2026-02-21T00:00:00.000Z',
        consecutive_failures: 5
      }
    ]
  };

  const fallback = mod.collectRegistryDarkCandidates(config, registry, {
    nowMs,
    minSilenceHours: 8,
    cadenceMultiplier: 2,
    failThreshold: 1,
    noSignalThreshold: 2
  });

  assert.ok(Array.isArray(fallback));
  assert.strictEqual(fallback.length, 2, 'expected two stale/failing non-stub eyes');
  assert.ok(fallback.every((r) => r && r.source === 'registry_fallback'));
  assert.ok(fallback.some((r) => r.eye_id === 'a' && r.dark_reason === 'stale_failures'));
  assert.ok(fallback.some((r) => r.eye_id === 'b' && r.dark_reason === 'stale_no_signal_runs'));
  assert.ok(!fallback.some((r) => r.eye_id === 'c'), 'fresh signal eye should not be dark candidate');
  assert.ok(!fallback.some((r) => r.eye_id === 'stub_eye'), 'stub eye should be excluded');
  assert.ok(!fallback.some((r) => r.eye_id === 'retired_eye'), 'retired eye should be excluded');

  const merged = mod.mergeSelfHealCandidates(
    [{ eye_id: 'a', dark_reason: 'silence_exceeded', source: 'temporal_patterns' }],
    [{ eye_id: 'a', dark_reason: 'stale_failures', source: 'registry_fallback' }, { eye_id: 'b', dark_reason: 'stale_no_signal_runs' }]
  );
  assert.strictEqual(merged.length, 2, 'merge should de-duplicate by eye_id');
  const a = merged.find((r) => r.eye_id === 'a');
  const b = merged.find((r) => r.eye_id === 'b');
  assert.ok(a && a.source === 'temporal_patterns', 'temporal candidate should win priority for duplicate eye');
  assert.ok(b && b.source === 'registry_fallback');

  console.log('external_eyes_self_heal.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`external_eyes_self_heal.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

