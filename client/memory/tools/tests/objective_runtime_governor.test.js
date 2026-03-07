#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  summarizeObjectiveRuntime,
  evaluateObjectiveRuntimeCandidate,
  settleObjectiveRuntimeOutcome
} = require('../../../systems/autonomy/objective_runtime_governor.js');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'objective_runtime_governor_'));
}

function run() {
  const tmpDir = makeTempDir();
  const settlementsPath = path.join(tmpDir, 'settlements.jsonl');
  const date = '2026-02-23';
  const policy = {
    enabled: true,
    window_days: 7,
    min_window_samples: 6,
    max_dominant_objective_share: 0.72,
    max_no_change_rate: 0.65,
    max_reverted_rate: 0.3,
    pressure_min_value_signal: 62,
    meta_no_change_streak_limit: 2,
    high_risk_exempt: true,
    lineage_required: false,
    meta_types: ['local_state_fallback', 'collector_remediation']
  };

  for (let i = 0; i < 5; i++) {
    settleObjectiveRuntimeOutcome({
      ts: `2026-02-23T0${i}:00:00.000Z`,
      dateStr: date,
      proposal_id: `A-${i}`,
      proposal_type: 'local_state_fallback',
      objective_id: 'T1_objA',
      outcome: 'no_change',
      risk: 'low',
      value_signal_score: 40
    }, { settlementsPath, policy });
  }
  settleObjectiveRuntimeOutcome({
    ts: '2026-02-23T09:00:00.000Z',
    dateStr: date,
    proposal_id: 'B-1',
    proposal_type: 'opportunity_capture',
    objective_id: 'T1_objB',
    outcome: 'shipped',
    risk: 'low',
    value_signal_score: 88
  }, { settlementsPath, policy });

  const summary = summarizeObjectiveRuntime(date, { settlementsPath, policy });
  assert.strictEqual(summary.enforced, true, 'runtime summary should enforce after enough settlements');
  assert.strictEqual(summary.total, 6, 'summary should include all settlements');
  assert.ok(Number(summary.dominant_share) > 0.72, 'dominant objective share should exceed configured cap');

  const blocked = evaluateObjectiveRuntimeCandidate({
    dateStr: date,
    summary,
    pool_objective_ids: ['T1_objA', 'T1_objB'],
    candidate: {
      proposal_id: 'A-next',
      proposal_type: 'local_state_fallback',
      objective_id: 'T1_objA',
      risk: 'low',
      value_signal_score: 40
    }
  });
  assert.strictEqual(blocked.pass, false, 'dominant low-value candidate should be blocked');
  assert.ok(
    ['objective_share_cap', 'meta_no_change_streak', 'no_change_pressure'].includes(String(blocked.reason || '')),
    'block reason should come from runtime guardrails'
  );

  const passHighRisk = evaluateObjectiveRuntimeCandidate({
    dateStr: date,
    summary,
    pool_objective_ids: ['T1_objA', 'T1_objB'],
    candidate: {
      proposal_id: 'A-high-risk',
      proposal_type: 'local_state_fallback',
      objective_id: 'T1_objA',
      risk: 'high',
      value_signal_score: 35
    }
  });
  assert.strictEqual(passHighRisk.pass, true, 'high-risk candidates should be exempt when configured');

  const passAlternative = evaluateObjectiveRuntimeCandidate({
    dateStr: date,
    summary,
    pool_objective_ids: ['T1_objA', 'T1_objB'],
    candidate: {
      proposal_id: 'B-next',
      proposal_type: 'opportunity_capture',
      objective_id: 'T1_objB',
      risk: 'low',
      value_signal_score: 85
    }
  });
  assert.strictEqual(passAlternative.pass, true, 'non-dominant high-value candidate should pass');

  const lineageCompiler = {
    resolveObjective(id) {
      if (id === 'T1_valid') {
        return {
          pass: true,
          reason: null,
          objective_id: id,
          root_objective_id: 'T1_valid',
          lineage_path: ['T1_valid'],
          depth: 1
        };
      }
      return {
        pass: false,
        reason: 'objective_unknown',
        objective_id: id || null,
        root_objective_id: null,
        lineage_path: [],
        depth: 0
      };
    }
  };
  const lineagePolicy = {
    ...policy,
    lineage_required: true,
    lineage_require_t1_root: true,
    lineage_block_missing_objective: true
  };
  const lineageBlocked = evaluateObjectiveRuntimeCandidate({
    dateStr: date,
    summary: { ...summary, policy: lineagePolicy },
    candidate: {
      proposal_id: 'X-1',
      proposal_type: 'opportunity_capture',
      objective_id: 'T1_unknown',
      risk: 'low',
      value_signal_score: 90
    }
  }, {
    directiveCompiler: lineageCompiler
  });
  assert.strictEqual(lineageBlocked.pass, false, 'unknown objective should fail lineage gate');
  assert.strictEqual(lineageBlocked.reason, 'objective_unknown', 'lineage gate should expose objective_unknown');

  const lineagePass = evaluateObjectiveRuntimeCandidate({
    dateStr: date,
    summary: { ...summary, policy: lineagePolicy },
    candidate: {
      proposal_id: 'X-2',
      proposal_type: 'opportunity_capture',
      objective_id: 'T1_valid',
      risk: 'low',
      value_signal_score: 90
    }
  }, {
    directiveCompiler: lineageCompiler
  });
  assert.strictEqual(lineagePass.pass, true, 'known objective should pass lineage gate');

  console.log('objective_runtime_governor.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`objective_runtime_governor.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
