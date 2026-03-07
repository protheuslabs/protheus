#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function mkDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function writeJson(filePath, obj) {
  mkDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

async function run() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const focusPath = path.join(repoRoot, 'adaptive', 'sensory', 'eyes', 'focus_triggers.json');
  const before = fs.existsSync(focusPath) ? fs.readFileSync(focusPath, 'utf8') : null;
  const tmpRoot = path.join(__dirname, 'temp_focus_controller');

  const envBefore = {
    FOCUS_SENSORY_DIR: process.env.FOCUS_SENSORY_DIR,
    FOCUS_FETCH_ENABLED: process.env.FOCUS_FETCH_ENABLED,
    FOCUS_BUDGET_ENABLED: process.env.FOCUS_BUDGET_ENABLED,
    OUTCOME_FITNESS_POLICY_PATH: process.env.OUTCOME_FITNESS_POLICY_PATH
  };

  try {
    if (fs.existsSync(tmpRoot)) fs.rmSync(tmpRoot, { recursive: true, force: true });
    mkDir(tmpRoot);
    process.env.FOCUS_SENSORY_DIR = path.join(tmpRoot, 'state', 'sensory');
    process.env.FOCUS_FETCH_ENABLED = '0';
    process.env.FOCUS_BUDGET_ENABLED = '0';
    process.env.OUTCOME_FITNESS_POLICY_PATH = path.join(tmpRoot, 'no_outcome_policy.json');

    const sensoryDir = process.env.FOCUS_SENSORY_DIR;
    writeJson(path.join(sensoryDir, 'proposals', '2026-02-21.json'), [
      {
        id: 'P1',
        title: 'Strengthen routing reliability',
        summary: 'Improve model fallback quality and reduce stale decisions',
        meta: {
          normalized_objective: 'Improve routing reliability',
          normalized_hint_tokens: ['routing', 'reliability', 'fallback']
        }
      }
    ]);
    writeJson(path.join(sensoryDir, 'anomalies', '2026-02-21.collectors.json'), {
      anomalies: [{ type: 'collector_starved', message: 'No external items in 24h' }]
    });

    const store = require('../../../systems/adaptive/sensory/eyes/focus_trigger_store.js');
    const focus = require('../../../systems/sensory/focus_controller.js');

    store.mutateFocusState(null, (state) => {
      const next = { ...state };
      next.policy = {
        ...(next.policy || {}),
        min_focus_score: 10,
        dynamic_focus_gate_enabled: false
      };
      next.triggers = Array.isArray(next.triggers) ? next.triggers.slice() : [];
      next.triggers.push({
        key: 'token:alpha',
        pattern: 'alpha',
        source: 'manual',
        status: 'active',
        weight: 95,
        cooldown_minutes: 0
      });
      next.eye_lenses = {
        ...(next.eye_lenses || {}),
        test_eye: {
          eye_id: 'test_eye',
          include_terms: ['orbital', 'routing'],
          exclude_terms: ['spammy'],
          term_weights: {
            orbital: 20,
            routing: 8
          },
          baseline_topics: ['routing'],
          focus_hits_total: 0,
          update_count: 1,
          created_ts: new Date('2026-02-21T00:00:00.000Z').toISOString(),
          updated_ts: new Date('2026-02-21T00:00:00.000Z').toISOString()
        }
      };
      return next;
    }, { reason: 'focus_controller_test_seed' });

    const refreshed = focus.maybeRefreshFocusTriggers({
      dateStr: '2026-02-21',
      force: true,
      reason: 'focus_controller_test'
    });
    assert.strictEqual(refreshed.ok, true, 'refresh should be ok');
    assert.strictEqual(refreshed.refreshed, true, 'refresh should run in force mode');
    assert.ok(Number(refreshed.trigger_count || 0) >= 1, 'should have trigger rows');
    assert.ok(refreshed.cadence_tuning && typeof refreshed.cadence_tuning === 'object', 'refresh should include cadence tuning payload');

    const evalRes = await focus.evaluateFocusForEye({
      eye: { id: 'test_eye', parser_type: 'hn_rss' },
      dateStr: '2026-02-21',
      maxFocusPerEye: 2,
      remainingRunBudget: 2,
      items: [
        {
          id: 'i1',
          collected_at: '2026-02-21T00:00:00.000Z',
          title: 'Alpha reliability playbook',
          url: 'https://example.com/alpha',
          topics: ['routing', 'stability'],
          bytes: 120
        },
        {
          id: 'i2',
          collected_at: '2026-02-21T00:00:00.000Z',
          title: 'Orbital routing note',
          url: 'https://example.com/misc',
          topics: ['misc'],
          bytes: 90
        },
        {
          id: 'i3',
          collected_at: '2026-02-21T00:00:00.000Z',
          title: 'Orbital spammy rumor',
          url: 'https://example.com/rumor',
          topics: ['misc'],
          bytes: 90
        }
      ]
    });

    assert.strictEqual(evalRes.ok, true, 'focus eval should be ok');
    assert.strictEqual(evalRes.min_focus_score_base, 10, 'base min focus score should be reported');
    assert.strictEqual(evalRes.min_focus_score, 10, 'effective min focus score should match base when dynamic gate is disabled');
    assert.ok(Number(evalRes.selected_count || 0) >= 1, 'should select at least one focus item');
    const focusedItems = (evalRes.items || []).filter((x) => x && x.focus_mode === 'focus');
    assert.ok(focusedItems.length >= 1, 'focused item should be annotated');
    assert.ok(Array.isArray(focusedItems[0].focus_trigger_hits), 'focus hits should exist');
    const lensFocused = focusedItems.find((x) => String(x.id) === 'i2');
    assert.ok(lensFocused, 'lens-matched item should be focused');
    assert.ok(Array.isArray(lensFocused.focus_lens_hits), 'lens hits should exist');
    assert.ok(lensFocused.focus_lens_hits.includes('orbital'), 'lens hits should include orbital');

    const status = focus.focusStatus();
    assert.strictEqual(status.ok, true, 'status should be ok');
    assert.ok(Number(status.lens_count || 0) >= 1, 'status should report lenses');
    assert.ok(status.cadence_tuning && typeof status.cadence_tuning === 'object', 'status should expose cadence tuning');

    const nowMs = Date.now();
    const recentHigh = {};
    for (let i = 0; i < 16; i++) recentHigh[`fp_${i}`] = new Date(nowMs - (i * 5 * 60 * 1000)).toISOString();
    const cadenceTight = focus.resolveFocusCadence({
      refresh_hours: 4,
      lens_refresh_hours: 6,
      adaptive_cadence_enabled: true,
      adaptive_cadence_focus_window_hours: 12,
      adaptive_cadence_focus_low_water: 2,
      adaptive_cadence_focus_high_water: 8,
      adaptive_cadence_min_interval_minutes: 30
    }, recentHigh, { realized_outcome_score: 35 }, nowMs);
    assert.strictEqual(cadenceTight.pressure_band, 'high', 'high pressure should be detected');
    assert.strictEqual(cadenceTight.outcome_band, 'low', 'low realized score should tighten cadence');
    assert.ok(
      Number(cadenceTight.effective_refresh_hours) < Number(cadenceTight.base_refresh_hours),
      'tight profile should reduce trigger refresh hours'
    );
    assert.ok(
      Number(cadenceTight.effective_lens_refresh_hours) < Number(cadenceTight.base_lens_refresh_hours),
      'tight profile should reduce lens refresh hours'
    );

    const cadenceRelaxed = focus.resolveFocusCadence({
      refresh_hours: 4,
      lens_refresh_hours: 6,
      adaptive_cadence_enabled: true,
      adaptive_cadence_focus_window_hours: 12,
      adaptive_cadence_focus_low_water: 2,
      adaptive_cadence_focus_high_water: 8,
      adaptive_cadence_min_interval_minutes: 30
    }, {}, { realized_outcome_score: 85 }, nowMs);
    assert.strictEqual(cadenceRelaxed.pressure_band, 'low', 'low pressure should be detected');
    assert.strictEqual(cadenceRelaxed.outcome_band, 'high', 'high realized score should relax cadence');
    assert.ok(
      Number(cadenceRelaxed.effective_refresh_hours) > Number(cadenceRelaxed.base_refresh_hours),
      'relaxed profile should increase trigger refresh hours'
    );
    assert.ok(
      Number(cadenceRelaxed.effective_lens_refresh_hours) > Number(cadenceRelaxed.base_lens_refresh_hours),
      'relaxed profile should increase lens refresh hours'
    );

    store.mutateFocusState(null, (state) => {
      const next = { ...state };
      next.policy = {
        ...(next.policy || {}),
        refresh_hours: 1,
        lens_refresh_hours: 1,
        adaptive_cadence_enabled: true,
        adaptive_cadence_min_interval_minutes: 240
      };
      next.last_refresh_ts = new Date(Date.now() - (10 * 60 * 1000)).toISOString();
      next.last_lens_refresh_ts = new Date(Date.now() - (10 * 60 * 1000)).toISOString();
      return next;
    }, { reason: 'focus_controller_cadence_min_interval_seed' });

    const skipped = focus.maybeRefreshFocusTriggers({
      dateStr: '2026-02-21',
      force: false,
      reason: 'focus_controller_cadence_min_interval_check'
    });
    assert.strictEqual(skipped.refreshed, false, 'cadence min-interval should skip refresh');
    assert.strictEqual(skipped.due_reason, 'cadence_min_interval', 'skip reason should reflect cadence min interval');
    assert.strictEqual(
      skipped.lens_refresh && skipped.lens_refresh.due_reason,
      'cadence_min_interval',
      'lens refresh should also respect cadence min interval'
    );

    console.log('focus_controller.test.js: OK');
  } finally {
    if (envBefore.FOCUS_SENSORY_DIR == null) delete process.env.FOCUS_SENSORY_DIR;
    else process.env.FOCUS_SENSORY_DIR = envBefore.FOCUS_SENSORY_DIR;
    if (envBefore.FOCUS_FETCH_ENABLED == null) delete process.env.FOCUS_FETCH_ENABLED;
    else process.env.FOCUS_FETCH_ENABLED = envBefore.FOCUS_FETCH_ENABLED;
    if (envBefore.FOCUS_BUDGET_ENABLED == null) delete process.env.FOCUS_BUDGET_ENABLED;
    else process.env.FOCUS_BUDGET_ENABLED = envBefore.FOCUS_BUDGET_ENABLED;
    if (envBefore.OUTCOME_FITNESS_POLICY_PATH == null) delete process.env.OUTCOME_FITNESS_POLICY_PATH;
    else process.env.OUTCOME_FITNESS_POLICY_PATH = envBefore.OUTCOME_FITNESS_POLICY_PATH;

    if (before == null) {
      if (fs.existsSync(focusPath)) fs.rmSync(focusPath, { force: true });
    } else {
      mkDir(path.dirname(focusPath));
      fs.writeFileSync(focusPath, before, 'utf8');
    }
    if (fs.existsSync(tmpRoot)) fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

run().catch((err) => {
  console.error(`focus_controller.test.js: FAIL: ${err.message}`);
  process.exit(1);
});
