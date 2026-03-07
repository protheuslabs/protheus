#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const {
  evaluateWindow,
  deriveMetricsFromHealthPayload
} = require('../../../systems/autonomy/drift_target_governor.js');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function run() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-target-governor-test-'));
  const policyPath = path.join(tmpRoot, 'policy.json');
  const statePath = path.join(tmpRoot, 'state.json');

  writeJson(policyPath, {
    version: '1.0',
    enabled: true,
    metric: {
      key: 'error_rate_recent',
      fallback_keys: ['spc_stop_ratio'],
      initial_target_rate: 0.03,
      floor_target_rate: 0.01,
      ceiling_target_rate: 0.1
    },
    ratchet: {
      tighten_step_rate: 0.0015,
      loosen_step_rate: 0.0025,
      good_window_streak_required: 2,
      bad_window_streak_required: 1,
      min_windows_between_adjustments: 1,
      history_limit: 30
    },
    guards: {
      min_samples: 6,
      min_verified_rate: 0.6,
      min_shipped_rate: 0.2
    }
  });

  const day1 = evaluateWindow({
    source: 'test',
    error_rate_recent: 0.02,
    attempted: 12,
    verified_rate: 0.9,
    shipped_rate: 0.4
  }, {
    dateStr: '2026-02-20',
    policyPath,
    statePath,
    write: true
  });
  assert.strictEqual(day1.decision.action, 'hold');
  assert.strictEqual(day1.decision.reason, 'good_window');
  assert.strictEqual(Number(day1.state.current_target_rate), 0.03);
  assert.ok(day1.decision.trit_shadow && day1.decision.trit_shadow.enabled === true, 'day1 should include trit shadow');
  assert.strictEqual(day1.decision.trit_shadow.action, 'tighten', 'day1 trit shadow should prefer tighten');
  assert.strictEqual(day1.decision.trit_shadow.divergence, true, 'day1 trit shadow should record divergence from legacy hold');

  const day2 = evaluateWindow({
    source: 'test',
    error_rate_recent: 0.015,
    attempted: 12,
    verified_rate: 0.9,
    shipped_rate: 0.4
  }, {
    dateStr: '2026-02-21',
    policyPath,
    statePath,
    write: true
  });
  assert.strictEqual(day2.decision.action, 'tighten');
  assert.strictEqual(Number(day2.state.current_target_rate), 0.0285);
  assert.ok(day2.trit_shadow && day2.trit_shadow.enabled === true, 'day2 result should expose trit shadow');
  assert.strictEqual(day2.decision.trit_shadow.action, 'tighten', 'day2 trit shadow should tighten');
  assert.strictEqual(day2.decision.trit_shadow.divergence, false, 'day2 trit shadow should match legacy action');

  const replay = evaluateWindow({
    source: 'test',
    error_rate_recent: 0.015,
    attempted: 12,
    verified_rate: 0.9,
    shipped_rate: 0.4
  }, {
    dateStr: '2026-02-21',
    policyPath,
    statePath,
    write: true
  });
  assert.strictEqual(Boolean(replay.replay), true);
  assert.strictEqual(Number(replay.state.windows_seen), Number(day2.state.windows_seen));

  const day3 = evaluateWindow({
    source: 'test',
    error_rate_recent: 0.05,
    attempted: 12,
    verified_rate: 0.9,
    shipped_rate: 0.4
  }, {
    dateStr: '2026-02-22',
    policyPath,
    statePath,
    write: true
  });
  assert.strictEqual(day3.decision.action, 'loosen');
  assert.strictEqual(Number(day3.state.current_target_rate), 0.031);
  assert.strictEqual(day3.decision.trit_shadow.action, 'loosen', 'day3 trit shadow should loosen');
  assert.strictEqual(day3.decision.trit_shadow.divergence, false, 'day3 trit shadow should match legacy action');

  const derived = deriveMetricsFromHealthPayload({
    autonomy: {
      tier1_governance: {
        drift: {
          metrics: {
            error_rate_recent: 0.011
          }
        }
      }
    },
    autonomy_receipts: {
      receipts: {
        combined: {
          attempted: 8,
          verified_rate: 0.75
        }
      },
      runs: {
        stop_ratio_quality: 0.41
      }
    },
    pipeline_spc: {
      current: {
        stop_ratio: 0.23
      }
    }
  });
  assert.strictEqual(Number(derived.error_rate_recent), 0.011);
  assert.strictEqual(Number(derived.spc_stop_ratio), 0.23);
  assert.strictEqual(Number(derived.verified_rate), 0.75);
  assert.strictEqual(Number(derived.attempted), 8);

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('drift_target_governor.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`drift_target_governor.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
